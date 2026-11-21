class A {
  private x: number = 1;
  readonly y: string = 'ok';
  get v(): number {
    return this.x;
  }
}

class B {
  private z: number;
  constructor(z: number) {
    this.z = z;
  }
  value(): number {
    return this.z;
  }
}

console.log(new A().v, new A().y, new B(7).value());
