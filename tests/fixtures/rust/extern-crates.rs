extern crate alloc;
extern crate core as rust_core;

pub fn dependencies() {
    alloc::boxed::Box::new(1);
    rust_core::mem::size_of::<usize>();
}
