use clap::Args;

#[derive(Args)]
pub struct Options {}

pub fn run(_options: Options) -> anyhow::Result<()> {
    println!("context not implemented yet");

    Ok(())
}
