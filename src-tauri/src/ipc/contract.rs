//! Cross-boundary IPC contract checks.
//!
//! These checks keep the registered Rust command surface, generated TypeScript bindings, and
//! validated argument boundary aligned. Runtime command probes remain separate because commands
//! that require a live account, webview, or upstream service need injectable test fixtures.

#[cfg(test)]
mod tests {
    use regex::Regex;

    const SOURCES: &[&str] = &[
        include_str!("account.rs"),
        include_str!("backup.rs"),
        include_str!("catalog.rs"),
        include_str!("downloads.rs"),
        include_str!("library.rs"),
        include_str!("lyrics.rs"),
        include_str!("player.rs"),
        include_str!("settings.rs"),
        include_str!("spotify.rs"),
        include_str!("system.rs"),
        include_str!("../updates.rs"),
    ];

    fn registered_commands() -> Vec<String> {
        let source = include_str!("../lib.rs");
        let registry = source
            .split_once("tauri::generate_handler![")
            .and_then(|(_, rest)| rest.split_once("])"))
            .map(|(registry, _)| registry)
            .expect("generate_handler registry");
        Regex::new(r"(?:ipc::\w+::|updates::)(\w+)")
            .unwrap()
            .captures_iter(registry)
            .map(|capture| capture[1].to_owned())
            .collect()
    }

    fn binding_commands() -> Vec<String> {
        let source = include_str!("../../../src/ipc/bindings.ts");
        let source = source
            .split_once("export type IpcCommandMap = {")
            .and_then(|(_, rest)| rest.split_once("\n};\n"))
            .map(|(map, _)| map)
            .expect("generated command map");
        Regex::new(r"(?m)^\s{2}([a-z][a-z0-9_]*)\s*:")
            .unwrap()
            .captures_iter(source)
            .map(|capture| capture[1].to_owned())
            .collect()
    }

    #[test]
    fn every_registered_command_has_one_generated_binding() {
        let mut registered = registered_commands();
        let mut bindings = binding_commands();
        registered.sort_unstable();
        registered.dedup();
        bindings.sort_unstable();
        bindings.dedup();
        assert_eq!(bindings.len(), registered.len());
        for command in registered {
            assert!(
                bindings.iter().any(|binding| binding == &command),
                "{command} is registered in Rust but absent from generated bindings"
            );
        }
    }

    #[test]
    fn every_registered_command_returns_the_structured_ipc_result() {
        let registered = registered_commands();
        let command_pattern = Regex::new(r"#\[tauri::command\][\s\S]*?\bfn\s+(\w+)\s*\(").unwrap();
        let return_pattern = Regex::new(r"\)\s*->\s*(?:crate::)?IpcResult<").unwrap();
        for command in registered {
            let mut found = false;
            for source in SOURCES {
                for candidate in command_pattern
                    .captures_iter(source)
                    .filter(|capture| capture[1] == command)
                {
                    let start = candidate.get(0).unwrap().start();
                    let signature = &source[start
                        ..source[start..]
                            .find('{')
                            .map_or(source.len(), |offset| start + offset)];
                    assert!(
                        return_pattern.is_match(signature),
                        "{command} does not return IpcResult"
                    );
                    found = true;
                }
            }
            assert!(
                found,
                "{command} is registered but has no command implementation"
            );
        }
    }
}
