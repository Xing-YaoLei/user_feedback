export interface Foo {
  a: number;
}
export const f = (x: number): number => x * 2;
export const g = (x: number): Foo => ({ a: x });
