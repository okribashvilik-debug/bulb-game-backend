export { DEFAULT_ODDS_CONFIG, type OddsConfig } from './config';
export { probabilityToCoefficient } from './coefficients';
export {
  generateDominantShape,
  generateDuelShape,
  generateWideOpenShape,
  generateShapeProbabilities,
  pickRandomShape,
  type ProbabilityShape,
} from './shapes';
export {
  decideWinningBulb,
  generateEliminationOrder,
  planCycleOutcome,
  type CycleOutcomePlan,
} from './outcomePlan';
export { computeSurvivalCurves } from './survivalCurves';
export { FixedOddsEngine, type OddsProvider } from './FixedOddsEngine';
export {
  runFixedOddsRtpSimulation,
  runMixedStrategyRtpSimulation,
  runRtpSimulation,
  type RtpSimulationResult,
} from './rtpSimulation';
