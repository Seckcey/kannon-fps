import type { PracticeDifficulty } from '../../shared/protocol';

export const PRACTICE_LEVELS: ReadonlyArray<{ id: PracticeDifficulty; name: string; description: string }> = [
  { id: 'easy', name: 'Relaxed', description: 'Slower reactions. Room to learn the arena.' },
  { id: 'normal', name: 'Balanced', description: 'Moving rivals that keep you on your toes.' },
  { id: 'hard', name: 'Challenging', description: 'Sharper aim. Make every piece of cover count.' },
];
export function practiceLevelName(difficulty?: PracticeDifficulty): string {
  return PRACTICE_LEVELS.find(level => level.id === (difficulty ?? 'normal'))!.name;
}
