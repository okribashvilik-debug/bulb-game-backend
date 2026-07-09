import { GameProvider } from './GameContext';
import { TopStrip } from './components/TopStrip';
import { MainEventArea } from './components/MainEventArea';
import { RightPanel } from './components/RightPanel';
import { ControlPanel } from './components/ControlPanel';
import { DecisionModal } from './components/DecisionModal';
import './styles.css';

export function App() {
  return (
    <GameProvider>
      <div className="app">
        <TopStrip />
        <MainEventArea />
        <RightPanel />
        <ControlPanel />
        <DecisionModal />
      </div>
    </GameProvider>
  );
}
