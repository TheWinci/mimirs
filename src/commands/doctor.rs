use clap::Args;

#[derive(Args)]
pub struct Options {}

pub fn run(_options: Options) -> anyhow::Result<()> {
  println!("doctor not implemented yet");

  Ok(())
}