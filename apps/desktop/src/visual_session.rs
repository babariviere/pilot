//! Transactional reader state. A frame commits only after hostile wire/tree/state validation.
use crate::{
    visual_runtime::{Fault, Process},
    visual_scene::Scene,
};
use serde_json::{Value, json};
use std::sync::Arc;
pub(crate) struct Program {
    pub(crate) source: String,
    pub(crate) data: Value,
    pub(crate) seed: String,
    pub(crate) now: f64,
}
pub(crate) struct Session {
    program: Program,
    process: Option<Process>,
    pub(crate) state: Option<String>,
    pub(crate) scene: Option<Arc<Scene>>,
    pub(crate) version: u64,
}
fn invalid(message: &str) -> Fault {
    Fault {
        kind: "result",
        message: message.into(),
        line: None,
        limit: None,
    }
}
impl Session {
    pub(crate) fn new(program: Program, state: Option<String>) -> Result<Self, Fault> {
        if program.source.len() > 256 * 1024
            || serde_json::to_vec(&program.data)
                .map_err(|_| invalid("Invalid visual data"))?
                .len()
                > 1024 * 1024
            || program.seed.len() > 128
            || !program.now.is_finite()
        {
            return Err(invalid("Visual source/data exceeds the supported limits"));
        }
        if let Some(state) = &state {
            validate_state(state)?;
        }
        Ok(Self {
            program,
            process: None,
            state,
            scene: None,
            version: 0,
        })
    }
    pub(crate) async fn prepare(&mut self) -> Result<(), Fault> {
        self.stop().await;
        let process = Process::start().await?;
        self.process = Some(process);
        Ok(())
    }
    /// Reconstruct idle closures from committed state before dispatch. A changed
    /// tree/state fails closed rather than targeting different controls.
    pub(crate) async fn resume(&mut self) -> Result<(), Fault> {
        let state = self.state.clone();
        let scene = self.scene.clone();
        let version = self.version;
        let result = self.load().await;
        let same = result.is_ok()
            && self.state == state
            && self.scene.as_ref().map(|s| &s.root) == scene.as_ref().map(|s| &s.root);
        self.version = version;
        if !same {
            self.state = state;
            self.scene = scene;
            self.stop().await;
            return result.and(Err(invalid(
                "Reader changed while resuming. Reopen this preview.",
            )));
        }
        Ok(())
    }
    pub(crate) async fn load(&mut self) -> Result<(), Fault> {
        let request = json!({"kind":"load","source":self.program.source,"data":self.program.data,"state":self.state,"seed":self.program.seed,"now":self.program.now});
        self.apply(request).await
    }
    #[cfg(all(test, target_os = "macos"))]
    pub(crate) async fn retry(&mut self) -> Result<(), Fault> {
        self.prepare().await?;
        self.load().await
    }
    pub(crate) fn clock(&mut self, now: f64) {
        if now.is_finite() {
            self.program.now = now;
        }
    }
    pub(crate) async fn draw(
        &mut self,
        version: u64,
        id: &str,
        width: f64,
        height: f64,
    ) -> Result<crate::visual_drawing::Drawing, Fault> {
        if version != self.version
            || self.process.is_none()
            || !width.is_finite()
            || !height.is_finite()
            || !(24.0..=600.).contains(&height)
            || !(1.0..=2000.).contains(&width)
            || self
                .scene
                .as_ref()
                .and_then(|s| s.canvases.iter().find(|(canvas, _)| canvas == id))
                .is_none_or(|(_, h)| (*h - height).abs() > 0.5)
        {
            return Err(invalid("This canvas request is no longer active"));
        }
        let result = self
            .process
            .as_mut()
            .unwrap()
            .drawing(
                json!({"kind":"draw","id":id,"width":width,"height":height,"t":0,"pointer":null}),
            )
            .await;
        if result.is_err() {
            self.stop().await;
        }
        result
    }
    pub(crate) async fn event(
        &mut self,
        version: u64,
        id: &str,
        value: Value,
    ) -> Result<(), Fault> {
        if version != self.version
            || self.process.is_none()
            || self
                .scene
                .as_ref()
                .and_then(|s| s.controls.get(id))
                .is_none_or(|control| !control.accepts(&value))
        {
            return Err(invalid("This visual control is no longer active"));
        }
        self.apply(json!({"kind":"event","id":id,"value":value,"now":self.program.now}))
            .await
    }
    async fn apply(&mut self, request: Value) -> Result<(), Fault> {
        let result = match self.process.as_mut() {
            Some(process) => process.exchange(request).await,
            None => Err(invalid("Visual helper is not active")),
        };
        let result = result.and_then(|value| self.commit(value));
        if let Err(mut error) = result {
            self.stop().await;
            if error
                .line
                .is_some_and(|n| n as usize > self.program.source.lines().count())
            {
                error.line = None;
            }
            return Err(error);
        }
        Ok(())
    }
    fn commit(&mut self, value: Value) -> Result<(), Fault> {
        let object = value
            .as_object()
            .ok_or_else(|| invalid("Invalid visual reply"))?;
        if object
            .keys()
            .any(|k| !matches!(k.as_str(), "ok" | "tree" | "state" | "changed"))
            || value["ok"] != true
        {
            return Err(invalid("Invalid visual reply"));
        }
        let state = value["state"]
            .as_str()
            .ok_or_else(|| invalid("Visual returned no reader state"))?;
        validate_state(state)?;
        let scene = Scene::parse(value["tree"].clone()).map_err(invalid)?;
        // No state mutation above this line. Failed renders never partially commit.
        self.state = Some(state.into());
        self.scene = Some(Arc::new(scene));
        self.version += 1;
        Ok(())
    }
    pub(crate) async fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            process.stop().await;
        }
    }
}
fn validate_state(state: &str) -> Result<(), Fault> {
    if state.encode_utf16().count() > 64 * 1024
        || !serde_json::from_str::<Value>(state)
            .map_err(|_| invalid("Invalid visual reader state"))?
            .is_array()
    {
        return Err(invalid("Invalid or oversized visual reader state"));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn idle_resume_preserves_state_version_and_rejects_changed_closures() {
        for (source, stateful) in [
            (
                "({ui,state})=>{const s=state({n:0});return()=>ui.column([ui.text(s.n),ui.button({label:'Change',onClick:()=>s.n++})]);}",
                true,
            ),
            (
                "({ui})=>{let n=0;return()=>ui.column([ui.text(n),ui.button({label:'Change',onClick:()=>n++})]);}",
                false,
            ),
        ] {
            let mut session = Session::new(
                Program {
                    source: source.into(),
                    data: Value::Null,
                    seed: "resume".into(),
                    now: 0.,
                },
                None,
            )
            .unwrap();
            session.retry().await.unwrap();
            session
                .event(session.version, "0.1", Value::Null)
                .await
                .unwrap();
            let version = session.version;
            let state = session.state.clone();
            let root = session.scene.as_ref().unwrap().root.clone();
            session.stop().await;
            session.prepare().await.unwrap();
            let result = session.resume().await;
            assert_eq!(result.is_ok(), stateful);
            assert_eq!(session.version, version);
            assert_eq!(session.state, state);
            assert_eq!(session.scene.as_ref().unwrap().root, root);
            if stateful {
                session.event(version, "0.1", Value::Null).await.unwrap();
            }
            session.stop().await;
        }
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn failed_handler_state_is_not_committed_and_retry_has_a_fresh_vm() {
        for failure in [
            "for(;;){}",
            "const a=[];for(;;)a.push(new Uint8Array(1024*1024));",
        ] {
            let source = format!(
                "({{ui,state}})=>{{const s=state({{n:0}});return()=>ui.column([ui.text(String(s.n)+':'+String(globalThis.partial||0)),ui.toggle({{label:'Synthetic',value:false,onChange:v=>{{s.n++;globalThis.partial=7;if(v){{{failure}}}}}}})]);}}"
            );
            let mut session = Session::new(
                Program {
                    source,
                    data: Value::Null,
                    seed: "synthetic".into(),
                    now: 0.,
                },
                None,
            )
            .unwrap();
            session.retry().await.unwrap();
            let initial = session.state.clone();
            let version = session.version;
            let error = session
                .event(version, "0.1", json!(true))
                .await
                .unwrap_err();
            assert!(matches!(error.kind, "timeout" | "memory"));
            assert_eq!(session.state, initial);
            assert!(session.process.is_none());
            session.retry().await.unwrap();
            assert_eq!(session.state, initial);
            assert_eq!(
                session.scene.as_ref().unwrap().root["children"][0]["runs"][0]["text"],
                "0:0"
            );
            assert!(session.event(version, "0.1", json!(false)).await.is_err());
            let version = session.version;
            session.event(version, "0.1", json!(false)).await.unwrap();
            assert_eq!(session.state.as_deref(), Some("[{\"n\":1}]"));
            session.stop().await;
        }
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn draw_interrupt_or_null_error_discards_vm_and_keeps_committed_state() {
        for failure in ["for(;;){}", "throw null;"] {
            let source="({ui,state})=>{const s=state({n:0});return()=>ui.column([ui.text(String(s.n)+':'+String(globalThis.partial||0)),ui.canvas({height:120,draw:g=>{globalThis.partial=7;__FAILURE__}})]);}".replace("__FAILURE__",failure);
            let mut session = Session::new(
                Program {
                    source,
                    data: Value::Null,
                    seed: "synthetic".into(),
                    now: 0.,
                },
                None,
            )
            .unwrap();
            session.retry().await.unwrap();
            let state = session.state.clone();
            let version = session.version;
            let error = session.draw(version, "0.1", 320., 120.).await.unwrap_err();
            assert!(matches!(error.kind, "timeout" | "memory"));
            assert!(session.process.is_none());
            assert_eq!(session.state, state);
            assert_eq!(session.version, version);
            session.retry().await.unwrap();
            assert_eq!(
                session.scene.as_ref().unwrap().root["children"][0]["runs"][0]["text"],
                "0:0"
            );
            assert!(session.draw(version, "0.1", 320., 120.).await.is_err());
            session.stop().await;
        }
    }
    #[test]
    fn invalid_frame_and_state_leave_committed_projection_unchanged() {
        let mut session = Session::new(
            Program {
                source: "()=>null".into(),
                data: Value::Null,
                seed: "synthetic".into(),
                now: 0.,
            },
            Some("[{\"n\":0}]".into()),
        )
        .unwrap();
        assert!(session.commit(json!({"ok":true,"state":"[{\"n\":1}]","tree":{"api":1,"root":{"type":"toggle","id":"wrong","label":"x","value":false}}})).is_err());
        assert_eq!(session.state.as_deref(), Some("[{\"n\":0}]"));
        assert!(
            session
                .commit(json!({"ok":true,"state":"{}","tree":{"api":1,"root":{"type":"rule"}}}))
                .is_err()
        );
        assert_eq!(session.version, 0);
    }
}
