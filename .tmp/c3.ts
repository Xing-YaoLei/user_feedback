type Bar<T> = { v: T };

class C {
  constructor(private readonly n: number) {}
  get(): number {
    return this.n;
  }
}

const b: Bar<string> = { v: 'x' };
console.log(b.v, new C(3).get());
