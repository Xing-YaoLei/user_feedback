interface Foo {
  a: number;
}

type Bar<T> = { v: T };
const enum E {
  A = 1,
}
enum Plain {
  X = 1,
}

class C {
  constructor(private readonly n: number) {}
  get(): number {
    return this.n;
  }
}

const b: Bar<string> = { v: 'x' };
const f: Foo = { a: 1 };
console.log(b.v, f.a, new C(3).get(), Plain.X, E.A);
