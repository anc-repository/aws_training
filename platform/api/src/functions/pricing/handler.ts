/**
 * atl-pricing — quotes from the Price List API (no hard-coded prices) (01 §3.2, 02 §3.2, §10.1, 04 §3.4).
 *
 *   PriceQuote   { purpose, region, labId, labVersion, catalogVersion, variant, alternativeVariants?, lines[],
 *                  durationMinutes, maxTotalMinutes, envId?, keepHours? } → the 08 §9.2 #6 quote structure
 *
 * The Price List source is injected: production passes `awsPriceListSource` (functions/pricing/index.ts), the dev
 * runtime and tests a fixture. Unknown actions throw `Atl.NotImplemented`.
 */
import { createActionDispatcher, type ActionHandler, type DepsProvider } from '../../runtime/deps.js';
import { awsPriceListSource, priceQuoteAction, type PriceListSource, type PricingActionOptions } from '../../services/pricing/index.js';

export const FUNCTION_NAME = 'atl-pricing';

const sources = new Map<string, PriceListSource>();

/**
 * Production source: Price List Query API through the function role. The endpoint region follows the platform region
 * (`priceListEndpointRegion`) unless `ATL_PRICING_ENDPOINT_REGION` is set; one client per container.
 */
export const AWS_PRICING: PricingActionOptions = {
  source: (_deps, region) => {
    let s = sources.get(region);
    if (!s) {
      const endpoint = process.env.ATL_PRICING_ENDPOINT_REGION;
      s = awsPriceListSource({ platformRegion: region, ...(endpoint ? { endpointRegion: endpoint } : {}) });
      sources.set(region, s);
    }
    return s;
  },
};

export function createPricingActions(opts: PricingActionOptions = AWS_PRICING): Record<string, ActionHandler> {
  return {
    PriceQuote: (p, deps) => priceQuoteAction(p, deps, opts),
  };
}

export const ACTIONS: Record<string, ActionHandler> = createPricingActions();

export function createPricingHandler(getDeps: DepsProvider, actions: Record<string, ActionHandler> = ACTIONS) {
  return createActionDispatcher(FUNCTION_NAME, actions, getDeps);
}
