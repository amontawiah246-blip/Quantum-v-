// Which setups may be traded.
//   confirmed (default): the indicator strategy (Stochastic + RSI trigger, confirmed by a candle pattern) creates the setup. The candle-pattern
//                        strategies are kept and used as the confirmation; on their own they do not trade.
//   legacy:              every candle-pattern strategy may trade on its own, as before (set STRATEGY_MODE=legacy).
export const candlePatternsTradeAlone = (): boolean =>
  String(typeof process !== 'undefined' ? process.env?.STRATEGY_MODE ?? '' : '').toLowerCase() === 'legacy';
