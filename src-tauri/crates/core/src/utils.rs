pub fn gen_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}
