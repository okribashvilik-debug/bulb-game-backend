export { DEFAULT_ODDS_CONFIG, type OddsConfig } from './config';
export {
  computeCoefficient,
  computeCoefficients,
  computeEliminatedPool,
  totalStakeByBulbId,
} from './parimutuel';
export { planCycleOutcome, type CycleOutcomePlan } from './outcomePlan';
export { PariMutuelEngine, type OddsProvider } from './PariMutuelEngine';
export {
  runPariMutuelSimulation,
  ALL_SCENARIOS,
  concentratedScenario,
  evenSpreadScenario,
  tenPlayersScenario,
  twoPlayersScenario,
  uncontestedScenario,
  type PariMutuelSimulationResult,
  type StakeScenario,
} from './rtpSimulation';
