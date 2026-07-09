import { createContext, useContext, type ReactNode } from 'react';
import { useBulbGame, type UseBulbGameResult } from './useBulbGame';

const GameContext = createContext<UseBulbGameResult | null>(null);

export function GameProvider({ children }: { children: ReactNode }) {
  const game = useBulbGame();
  return <GameContext.Provider value={game}>{children}</GameContext.Provider>;
}

export function useGame(): UseBulbGameResult {
  const value = useContext(GameContext);
  if (!value) {
    throw new Error('useGame() must be called within <GameProvider>');
  }
  return value;
}
