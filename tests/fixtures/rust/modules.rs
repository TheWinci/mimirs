mod external;

pub mod nested {
    pub fn run() {
        helper();
    }

    fn helper() {}
}

pub fn start() {
    nested::run();
}
