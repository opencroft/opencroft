import { Setting as PrismaSetting } from '@prisma/client';

export type Setting<T = Record<string, unknown>> = Omit<PrismaSetting, 'data'> & {
  data: T;
};
