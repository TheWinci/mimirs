mod nested {
    pub struct Café { pub value: u32 }
    struct Pair(pub u8, String);
    union Bits { byte: u8, word: u32 }
    enum Choice { Empty, Tuple(u8), Named { yes: bool } }
    trait Work { type Output; const LIMIT: usize; fn run(&self); }
    impl Work for Café { type Output = (); const LIMIT: usize = 1; fn run(&self) { fn inner() {} } }
    type Alias = Café;
    const VALUE: u8 = 1;
    static mut GLOBAL: u8 = 0;
    macro_rules! make { () => { fn hidden() {} } }
}
fn same() {} fn same() {}
