pub fn greet(name: &str) -> String {
    format_name(name)
}

pub async fn fetch(loader: impl Fn() -> String) -> String {
    loader().await
}

pub fn transform(value: &str) -> String {
    let normalize = |input: &str| clean(input);
    normalize(value)
}
