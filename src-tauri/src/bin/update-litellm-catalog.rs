#[tokio::main]
async fn main() {
    if let Err(error) = aqbot_lib::model_catalog_tools::run(std::env::args().skip(1)).await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
