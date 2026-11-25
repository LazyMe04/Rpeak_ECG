//! The dataset-root decision, tested without a window.
//!
//! These live here rather than beside the code in `src/source.rs` because the
//! library's unit-test harness cannot start on this toolchain — see
//! `build.rs` for the manifest and its 0xc0000139 symptom. `tests/` is a link
//! target for `rustc-link-arg-tests`, so it gets the manifest.

use std::path::{Path, PathBuf};

use rpeak_lib::source::{check_root, resolve_from, safe_relative, Candidates, Origin};

/// A directory that is removed with the test.
struct Temp(PathBuf);

impl Temp {
    fn new(name: &str) -> Self {
        let p = std::env::temp_dir().join(format!("rpeak-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Temp(p)
    }

    /// A folder that passes `check_root`: one segment, one model.
    fn dataset(name: &str) -> Self {
        let t = Temp::new(name);
        std::fs::create_dir_all(t.0.join("catalog")).unwrap();
        std::fs::write(
            t.0.join("catalog/segments.json"),
            r#"[{"record":"p00000_s00"}]"#,
        )
        .unwrap();
        std::fs::create_dir_all(t.0.join("models")).unwrap();
        std::fs::write(t.0.join("models/beatcnn.json"), "{}").unwrap();
        t
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn env_wins_over_a_remembered_choice() {
    let env = Temp::dataset("env");
    let stored = Temp::dataset("stored");
    let c = Candidates {
        env: Some(env.0.clone()),
        stored: Some(stored.0.clone()),
        ..Default::default()
    };
    let (path, origin, remembered) = resolve_from(&c);
    assert_eq!(path, env.0);
    assert_eq!(origin, Origin::Env);
    // A preference silently overridden is a lie by omission: the choice that
    // lost must still be reported so the UI can say so.
    assert_eq!(remembered, Some(stored.0.display().to_string()));
}

/// The env arm used to report no remembered choice at all, which made the UI's
/// "RPEAK_DATA_DIR overrides the folder you chose" branch unreachable — a
/// sentence that looked implemented and could never be shown. This is the test
/// that fails if it goes back.
#[test]
fn an_overridden_choice_is_still_reported() {
    let env = Temp::dataset("env2");
    let stored = Temp::dataset("stored3");
    let c = Candidates {
        env: Some(env.0.clone()),
        stored: Some(stored.0.clone()),
        ..Default::default()
    };
    let (_, origin, remembered) = resolve_from(&c);
    assert_eq!(origin, Origin::Env);
    assert_eq!(
        remembered.as_deref(),
        Some(stored.0.display().to_string().as_str())
    );
}

#[test]
fn using_the_remembered_choice_reports_nothing_extra() {
    let stored = Temp::dataset("stored4");
    let c = Candidates {
        stored: Some(stored.0.clone()),
        ..Default::default()
    };
    let (_, origin, remembered) = resolve_from(&c);
    assert_eq!(origin, Origin::Chosen);
    assert_eq!(remembered, None);
}

#[test]
fn a_remembered_choice_wins_over_beside_exe() {
    let stored = Temp::dataset("stored2");
    let beside = Temp::dataset("beside");
    let c = Candidates {
        stored: Some(stored.0.clone()),
        beside_exe: Some(beside.0.clone()),
        ..Default::default()
    };
    let (path, origin, remembered) = resolve_from(&c);
    assert_eq!(path, stored.0);
    assert_eq!(origin, Origin::Chosen);
    assert_eq!(remembered, None);
}

#[test]
fn a_remembered_choice_that_is_gone_falls_through_and_is_reported() {
    let beside = Temp::dataset("beside2");
    let gone = beside.0.join("this-does-not-exist");
    let c = Candidates {
        stored: Some(gone.clone()),
        beside_exe: Some(beside.0.clone()),
        ..Default::default()
    };
    let (path, origin, remembered) = resolve_from(&c);
    assert_eq!(path, beside.0);
    assert_eq!(origin, Origin::BesideExe);
    assert_eq!(remembered, Some(gone.display().to_string()));
}

#[test]
fn nothing_found_reports_the_portable_location_and_no_origin() {
    let beside = std::env::temp_dir().join("rpeak-test-nowhere");
    let c = Candidates {
        beside_exe: Some(beside.clone()),
        ..Default::default()
    };
    let (path, origin, _) = resolve_from(&c);
    assert_eq!(path, beside);
    assert_eq!(origin, Origin::None);
}

#[test]
fn a_folder_without_a_catalog_is_rejected_and_names_the_file() {
    let t = Temp::new("not-a-dataset");
    let err = check_root(&t.0).unwrap_err();
    assert!(err.contains("catalog"), "{err}");
    assert!(err.contains("segments.json"), "{err}");
}

#[test]
fn a_relative_path_is_rejected() {
    let err = check_root(Path::new("data")).unwrap_err();
    assert!(err.contains("absolute"), "{err}");
}

#[test]
fn a_real_dataset_passes_and_a_missing_model_is_only_a_warning() {
    let t = Temp::dataset("real");
    assert!(check_root(&t.0).unwrap().is_empty());
    std::fs::remove_file(t.0.join("models/beatcnn.json")).unwrap();
    let w = check_root(&t.0).unwrap();
    assert_eq!(w, vec!["models/beatcnn.json".to_string()]);
}

#[test]
fn an_empty_catalogue_is_rejected() {
    let t = Temp::dataset("empty");
    std::fs::write(t.0.join("catalog/segments.json"), "[]").unwrap();
    let err = check_root(&t.0).unwrap_err();
    assert!(err.contains("empty"), "{err}");
}

#[test]
fn safe_relative_rejects_every_escape() {
    assert!(safe_relative("../data").is_none());
    assert!(safe_relative("a/../../b").is_none());
    assert!(safe_relative("C:/Windows").is_none());
    assert!(safe_relative("").is_none());
    assert_eq!(
        safe_relative("/catalog/segments.json").unwrap(),
        PathBuf::from("catalog/segments.json")
    );
}

/// The origin names are what `src/lib/source.ts` switches on to choose a chip,
/// and a rename would leave the page showing the wrong one without any test
/// noticing — the page's own tests feed themselves their own JSON.
#[test]
fn origin_serializes_as_the_frontend_expects() {
    let pairs = [
        (Origin::Env, "\"env\""),
        (Origin::Chosen, "\"chosen\""),
        (Origin::BesideExe, "\"besideExe\""),
        (Origin::LocalAppData, "\"localAppData\""),
        (Origin::RepoDebug, "\"repoDebug\""),
        (Origin::None, "\"none\""),
    ];
    for (origin, expected) in pairs {
        assert_eq!(serde_json::to_string(&origin).unwrap(), expected);
    }
}
