export { DEFAULT_ODDS_CONFIG, type OddsConfig } from './config';
export {
  computeCoefficient,
  computeCoefficients,
  computeEliminatedPool,
  computeHouseTake,
  totalStakeByBulbId,
} from './parimutuel';
export { planCycleOutcome, type CycleOutcomePlan } from './outcomePlan';
export { PariMutuelEngine, type OddsProvider } from './PariMutuelEngine';
export {
  runPariMutuelSimulation,
  runCashOutBehaviorSimulation,
  ALL_SCENARIOS,
  ALL_CASHOUT_BEHAVIORS,
  concentratedScenario,
  evenSpreadScenario,
  tenPlayersScenario,
  twoPlayersScenario,
  uncontestedScenario,
  neverCashOutBehavior,
  alwaysCashOutBehavior,
  mixedCashOutBehavior,
  type CashOutBehavior,
  type CashOutSimulationResult,
  type CycleHouseTakeSample,
  type PariMutuelSimulationResult,
  type StakeScenario,
} from './rtpSimulation';
