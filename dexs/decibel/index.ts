import { FetchOptions, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { getEnv } from "../../helpers/env";
import { httpGet, httpPost } from "../../utils/fetchURL";

const API_URL = "https://api.mainnet.aptoslabs.com/decibel/api/v1/daily_stats";
const APTOS_GRAPHQL = "https://api.mainnet.aptoslabs.com/v1/graphql";

// matches fee_treasury::get_fee_vault_address() on the Decibel package
const FEE_TREASURY_ADDRESS =
  "0xa6ebf45cef6b683cf4275ee8c5f8f92f956a332174f8fd69143daf90115077f2";

const DECIBEL_PACKAGE =
  "0x50ead22afd6ffd9769e3b3d6e0e64a2a350d68e8b102c4e72e33d0b8cfdfdb06";

// both are 6-decimal fungible assets on Aptos
const FEE_ASSET_TYPES = new Set([
  // Native USDC on Aptos (Circle CCTP)
  "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b",
  // USDCbl
  "0x96401f1e3ab3245d056d5a1ba67eef066ac3edc4d5f1b16adc5d567e79a845b0",
]);

const USD_DECIMALS = 1e6;

// the Aptos indexer caps a single response at 100 rows regardless of the requested limit
const PAGE_SIZE = 100;
// runaway-pagination guard: the busiest day on record is ~600 deposits, so 200 pages is
// far past any real window and only trips if the loop stops terminating
const MAX_ROWS = 20000;

// Decibel spot fees are deducted from the asset a user *receives* at settlement
// (base for a buyer, quote for a seller) and deposited into a per-asset store
// held by the spot fee treasury (decibel_dex::spot_fees_treasury). These are the
// on-chain addresses of those per-asset stores, read from the treasury's `stores`
// table on mainnet. Deposits into them are the spot trading fees.
//
// We filter by the store address (not the treasury/package owner) because the
// package also owns unrelated stores holding the same assets. Unlike the perps
// treasury above, spot fees are NOT reported by the stats API, so every deposit
// here is counted (no entry_function filtering). Store addresses are stable
// (created once, then reused); a new spot asset would create a new store that
// must be added here.
const SPOT_FEE_STORES: Record<string, "apt" | "usdc" | "btc"> = {
  "0xc877fe567ffb12fe883288500fdb4b4e165f276a92b7d5b7e4e7ffd5a03ed82a": "apt",
  "0x1c200bcac260762c432d55734e5265a09ce8ac867be3f6db8d89f6d1dffee0f4": "usdc",
  "0xdba6b823cf3f7bbbb43cc318a25699232de48252cdb96c5abe9be7224626f90b": "btc",
};

// APT native FA and USDC ids used to price spot fees. NBTC ("Near WBTC", 8 dp)
// is the spot BTC asset; DefiLlama has no price for its fungible asset, so it is
// priced 1:1 against bitcoin.
const APT_FA = "0xa";
const USDC_FA =
  "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b";
const BTC_UNITS = 1e8;
// spot deposits are frequent (thousands/day); guard only against a non-terminating loop
const MAX_SPOT_ROWS = 200000;

interface DailyStatsResponse {
  daily_volume: number;
  daily_fees: number;
  daily_revenue: number;
  open_interest: number;
}

const postIndexer = async (body: any, retries = 3): Promise<any> => {
  let lastError: any;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await httpPost(APTOS_GRAPHQL, body, {
        headers: { Authorization: `Bearer ${getEnv("DECIBEL_API_KEY")}` },
      });
      if (response.errors)
        throw new Error(
          `decibel: indexer query failed: ${response.errors
            .map((error: any) => error.message)
            .join("; ")}`
        );
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1)
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
};

const getTreasuryDepositsUsd = async (
  startTimestamp: number,
  endTimestamp: number
): Promise<number> => {
  const fromDate = new Date(startTimestamp * 1000).toISOString();
  const toDate = new Date(endTimestamp * 1000).toISOString();

  // Note: filtering by asset_type alongside owner_address triggers a slow query plan on
  // the Aptos indexer, so we fetch all deposits to the treasury in the window and filter
  // to the fee-bearing asset types client-side.
  const query = `
      query GetTreasuryDeposits($owner: String!, $fromDate: timestamp!, $toDate: timestamp!, $limit: Int!, $offset: Int!) {
        fungible_asset_activities(
          where: {
            owner_address: { _eq: $owner },
            type: { _eq: "0x1::fungible_asset::Deposit" },
            transaction_timestamp: { _gte: $fromDate, _lt: $toDate }
          }
          order_by: { transaction_version: asc }
          limit: $limit
          offset: $offset
        ) {
          amount
          asset_type
          entry_function_id_str
        }
      }
    `;

  let total = 0;
  let offset = 0;

  while (true) {
    const response = await httpPost(
      APTOS_GRAPHQL,
      {
        query,
        variables: {
          owner: FEE_TREASURY_ADDRESS,
          fromDate,
          toDate,
          limit: PAGE_SIZE,
          offset,
        },
      },
      { headers: { Authorization: `Bearer ${getEnv("DECIBEL_API_KEY")}` } }
    );
    if (response.errors)
      throw new Error(`decibel: treasury deposit query failed: ${response.errors.map((error: any) => error.message).join("; ")}`);

    const activities: {
      amount: string;
      asset_type: string;
      entry_function_id_str: string | null;
    }[] = response.data.fungible_asset_activities;

    for (const activity of activities) {
      // deposits made inside Decibel's own transactions are per-trade fee routing, which the
      // stats API already reports as fees; only count value arriving from outside the exchange
      const entryFunction = activity.entry_function_id_str;
      if (entryFunction !== null && entryFunction.startsWith(DECIBEL_PACKAGE)) continue;
      if (FEE_ASSET_TYPES.has(activity.asset_type)) {
        total += Number(activity.amount) / USD_DECIMALS;
      }
    }

    if (activities.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (offset >= MAX_ROWS)
      throw new Error(`decibel: treasury deposits exceeded ${MAX_ROWS} rows`);
  }

  return total;
};

// Sum raw spot trading fees per asset (APT, USDC, BTC) collected into the spot
// fee treasury stores over the window. The indexer caps every page at PAGE_SIZE
// rows regardless of the requested limit (and offset queries degrade quickly at
// this volume), so we keyset-paginate on (transaction_version, event_index).
const getSpotFeesRaw = async (
  options: FetchOptions
): Promise<{ apt: number; usdc: number; btc: number }> => {
  const fromDate = new Date(options.startTimestamp * 1000).toISOString();
  const toDate = new Date(options.endTimestamp * 1000).toISOString();
  const storeList = Object.keys(SPOT_FEE_STORES)
    .map((store) => `"${store}"`)
    .join(",");

  const totals = { apt: 0, usdc: 0, btc: 0 };
  let cursor: { version: string; eventIndex: string } | null = null;
  let rowsSeen = 0;

  while (true) {
    const cursorFilter = cursor
      ? `, _or: [
            { transaction_version: { _lt: "${cursor.version}" } },
            { transaction_version: { _eq: "${cursor.version}" }, event_index: { _lt: "${cursor.eventIndex}" } }
          ]`
      : "";
    const query = `
      query GetSpotFeeDeposits {
        fungible_asset_activities(
          where: {
            storage_id: { _in: [${storeList}] },
            type: { _eq: "0x1::fungible_asset::Deposit" },
            transaction_timestamp: { _gte: "${fromDate}", _lt: "${toDate}" }${cursorFilter}
          }
          order_by: [{ transaction_version: desc }, { event_index: desc }]
          limit: ${PAGE_SIZE}
        ) {
          amount
          storage_id
          transaction_version
          event_index
        }
      }
    `;

    const response = await postIndexer({ query });
    const rows: {
      amount: string;
      storage_id: string;
      transaction_version: string;
      event_index: string;
    }[] = response.data.fungible_asset_activities;

    for (const row of rows) {
      const kind = SPOT_FEE_STORES[row.storage_id];
      if (kind) totals[kind] += Number(row.amount);
    }

    rowsSeen += rows.length;
    if (rows.length < PAGE_SIZE) break;
    if (rowsSeen >= MAX_SPOT_ROWS)
      throw new Error(`decibel: spot fee deposits exceeded ${MAX_SPOT_ROWS} rows`);
    const last = rows[rows.length - 1];
    cursor = { version: last.transaction_version, eventIndex: last.event_index };
  }

  return totals;
};

const fetch = async (options: FetchOptions) => {
  const url = `${API_URL}?start_timestamp=${options.startTimestamp}&end_timestamp=${options.endTimestamp}`;
  const [data, treasuryDepositsUsd, spotFees] = await Promise.all([
    httpGet(url, {
      headers: { Authorization: `Bearer ${getEnv("DECIBEL_API_KEY")}` },
    }) as Promise<DailyStatsResponse>,
    getTreasuryDepositsUsd(options.startTimestamp, options.endTimestamp),
    getSpotFeesRaw(options),
  ]);

  const dailyFees = options.createBalances();
  const dailyUserFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  const dailySupplySideRevenue = options.createBalances();

  dailyFees.addUSDValue(data.daily_fees, "Trading Fees");
  dailyFees.addUSDValue(treasuryDepositsUsd, "Fee Treasury Deposits");

  // traders pay the trading fees; they do not pay the treasury deposits
  dailyUserFees.addUSDValue(data.daily_fees, "Trading Fees");

  dailyRevenue.addUSDValue(data.daily_revenue, 'Trading Fees Kept By Decibel');
  dailyRevenue.addUSDValue(treasuryDepositsUsd, "Fee Treasury Deposits");

  dailySupplySideRevenue.addUSDValue(data.daily_fees - data.daily_revenue, 'Maker Rebates');

  // On-chain spot trading fees, collected in APT, BTC and USDC. Traders pay
  // them and the protocol keeps them gross (no maker rebate netting on-chain),
  // so they count toward fees, user fees and revenue alike.
  for (const target of [dailyFees, dailyUserFees, dailyRevenue]) {
    target.add(APT_FA, spotFees.apt, "Spot Trading Fees");
    target.add(USDC_FA, spotFees.usdc, "Spot Trading Fees");
    target.addCGToken("bitcoin", spotFees.btc / BTC_UNITS, "Spot Trading Fees");
  }

  return {
    dailyVolume: data.daily_volume,
    dailyFees,
    dailyUserFees,
    dailyRevenue,
    dailyProtocolRevenue: dailyRevenue,
    dailySupplySideRevenue,
    openInterestAtEnd: data.open_interest,
  };
};

const methodology = {
  Volume: "Notional value of the perpetual futures trades reported by Decibel's daily stats endpoint.",
  Fees: "Trading fees charged on every fill. Takers always pay, between 0.034% and 0.018% depending on their 30-day volume, and makers pay between 0.011% and 0% until they reach the top volume tiers. Also includes USDC and USDCbl paid into Decibel's fee treasury from outside the exchange, and on-chain spot trading fees collected in APT, BTC and USDC.",
  UserFees: "Trading fees paid by traders, including on-chain spot trading fees paid in APT, BTC and USDC. Excludes the treasury deposits, which traders do not pay.",
  Revenue: "Everything Decibel charges, minus any maker rebates it nets out, plus the treasury deposits and on-chain spot trading fees.",
  ProtocolRevenue: "All revenue goes to Decibel's treasury. Decibel has no live token, so nothing is distributed to token holders.",
  SupplySideRevenue: "Zero. Decibel has no maker rebate program running: its market-maker rebate tiers are empty on-chain and makers currently pay a fee rather than earn one. This turns non-zero on its own if rebates are switched on."
};

const breakdownMethodology = {
  Fees: {
    'Trading Fees': 'Fees charged on perpetual futures fills, paid by takers and by makers below the top volume tiers.',
    'Fee Treasury Deposits': 'USDC and USDCbl transferred into Decibel\'s fee treasury from outside the exchange, on top of what the trading stats report.',
    'Spot Trading Fees': 'On-chain spot trading fees collected in APT, BTC and USDC and deposited into Decibel\'s spot fee treasury.',
  },
  UserFees: {
    'Trading Fees': 'Fees charged on perpetual futures fills, paid by takers and by makers below the top volume tiers.',
    'Spot Trading Fees': 'On-chain spot trading fees paid by traders in APT, BTC and USDC.',
  },
  Revenue: {
    'Trading Fees Kept By Decibel': 'Trading fees left after any maker rebates are netted out.',
    'Fee Treasury Deposits': 'USDC and USDCbl transferred into Decibel\'s fee treasury from outside the exchange.',
    'Spot Trading Fees': 'On-chain spot trading fees collected in APT, BTC and USDC.',
  },
  ProtocolRevenue: {
    'Trading Fees Kept By Decibel': 'Trading fees kept by the treasury. Decibel has no live token, so none of it goes to token holders.',
    'Fee Treasury Deposits': 'USDC and USDCbl transferred into Decibel\'s fee treasury from outside the exchange.',
    'Spot Trading Fees': 'On-chain spot trading fees collected in APT, BTC and USDC.',
  },
  SupplySideRevenue: {
    'Maker Rebates': 'Rebates paid to market makers. Currently zero, as no rebate tier is configured on-chain.',
  },
}

const adapter: SimpleAdapter = {
  version: 2,
  adapter: {
    [CHAIN.APTOS]: {
      fetch,
      start: "2026-02-19",
    },
  },
  methodology,
  breakdownMethodology,
  isExpensiveAdapter: true,
};

export default adapter;
