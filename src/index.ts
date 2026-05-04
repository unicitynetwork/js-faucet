/**
 * js-faucet entry point. Re-exports the ACP-adapter starter so this
 * package can also be consumed as a library by tests.
 */

export { startFaucet } from './acp-adapter/main.js';
export {
  handleFaucetRequest,
  type FaucetRequestParams,
  type FaucetRequestItem,
  type FaucetDelivery,
  type FaucetResult,
  type FaucetSuccessResult,
  type FaucetErrorResult,
} from './acp-adapter/faucet-handler.js';
export { resolveCoinId, listKnownSymbols } from './acp-adapter/coin-registry.js';
