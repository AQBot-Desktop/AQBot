use super::*;

fn prompt(text: &str) -> Message {
    Message {
        role: MessageRole::User,
        content: vec![ContentBlock::Text { text: text.into() }],
    }
}

fn history(ids: &[&str]) -> AgentHistory {
    AgentHistory {
        messages: ids.iter().map(|id| prompt(id)).collect(),
        prompt_ids: ids.iter().map(|id| Some((*id).into())).collect(),
    }
}

fn users(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| (*id).into()).collect()
}

fn roundtrip(history: AgentHistory) -> AgentHistory {
    load_history(Some(
        &serialize_history(&history.messages, Some(&history.prompt_ids)).unwrap(),
    ))
    .unwrap()
}

#[test]
fn repeated_middle_regeneration_preserves_the_first_turn() {
    let active = users(&["A", "B", "C"]);
    let mut context =
        history_before_regeneration(roundtrip(history(&["A", "B", "C"])), &active, "B").unwrap();
    context.messages.push(prompt("B revised"));
    context.prompt_ids.push(Some("B".into()));
    let saved = serialize_history(&context.messages, Some(&context.prompt_ids)).unwrap();
    let repeated =
        history_before_regeneration(load_history(Some(&saved)).unwrap(), &active, "B").unwrap();
    assert_eq!(
        repeated.messages.len(),
        1,
        "the completed A turn must survive"
    );
    assert_eq!(repeated.prompt_ids, vec![Some("A".into())]);
    let next =
        history_before_regeneration(load_history(Some(&saved)).unwrap(), &active, "C").unwrap();
    assert_eq!(next.prompt_ids, vec![Some("A".into()), Some("B".into())]);
}

#[test]
fn failed_unsent_and_deleted_turns_do_not_shift_identity() {
    let active = users(&["A", "failed", "B", "C", "D"]);
    let context = history_before_regeneration(
        roundtrip(history(&["A", "deleted", "B", "D"])),
        &active,
        "C",
    )
    .unwrap();
    assert_eq!(context.prompt_ids, vec![Some("A".into()), Some("B".into())]);
    let context =
        history_before_regeneration(roundtrip(history(&["A", "B", "D"])), &active, "D").unwrap();
    assert_eq!(context.prompt_ids, vec![Some("A".into()), Some("B".into())]);
    let first = history_before_regeneration(history(&["A", "B"]), &active, "A").unwrap();
    assert!(first.messages.is_empty());
}

#[test]
fn keeps_tool_results_with_their_user_turn_and_not_as_prompts() {
    let mut context = history(&["A"]);
    context.messages.push(Message {
        role: MessageRole::User,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "tool-1".into(),
            content: vec![open_agent_sdk::types::ToolResultContentBlock::Text {
                text: "tool output".into(),
            }],
            is_error: false,
        }],
    });
    context.messages.push(Message {
        role: MessageRole::Assistant,
        content: vec![ContentBlock::Text {
            text: "answer".into(),
        }],
    });
    context.messages.push(prompt("B"));
    context.prompt_ids.push(Some("B".into()));
    let context =
        history_before_regeneration(roundtrip(context), &users(&["A", "B"]), "B").unwrap();
    assert_eq!(context.messages.len(), 3);
    assert_eq!(context.prompt_ids, vec![Some("A".into())]);
    assert!(matches!(
        context.messages[1].content[0],
        ContentBlock::ToolResult { .. }
    ));
}

#[test]
fn legacy_history_continues_but_ambiguous_regeneration_fails_explicitly() {
    let legacy = serde_json::to_string(&[prompt("old A"), prompt("old B")]).unwrap();
    let mut context = load_history(Some(&legacy)).unwrap();
    assert_eq!(context.messages.len(), 2);
    assert_eq!(context.prompt_ids, vec![None, None]);
    context.messages.push(prompt("C"));
    context.prompt_ids.push(Some("C".into()));
    let saved = serialize_history(&context.messages, Some(&context.prompt_ids)).unwrap();
    let known = history_before_regeneration(
        load_history(Some(&saved)).unwrap(),
        &users(&["A", "B", "C"]),
        "C",
    )
    .unwrap();
    assert_eq!(known.messages.len(), 2);
    let error = history_before_regeneration(
        load_history(Some(&saved)).unwrap(),
        &users(&["A", "B", "C"]),
        "B",
    )
    .err()
    .unwrap();
    assert!(error.contains("AGENT_HISTORY_UNTRACKED"));
    let first = history_before_regeneration(
        load_history(Some(&legacy)).unwrap(),
        &users(&["A", "B"]),
        "A",
    )
    .unwrap();
    assert!(first.messages.is_empty());
}

#[test]
fn missing_target_and_corrupt_context_are_errors() {
    assert!(history_before_regeneration(history(&["A"]), &users(&["A"]), "missing").is_err());
    assert!(load_history(Some("invalid json")).is_err());
    assert!(serialize_history(&[prompt("A")], Some(&[])).is_err());
}
