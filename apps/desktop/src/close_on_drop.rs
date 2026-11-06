//! Worker-exit closure for lanes whose producer keeps a receiver for replacement.

pub(crate) struct CloseOnDrop<T>(pub(crate) async_channel::Receiver<T>);

impl<T> Drop for CloseOnDrop<T> {
    fn drop(&mut self) {
        self.0.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closes_with_another_receiver_alive_and_keeps_queued_values() {
        let (sender, receiver) = async_channel::bounded(1);
        let replacement = receiver.clone();
        sender.try_send(7).unwrap();
        drop(CloseOnDrop(receiver));
        assert!(replacement.is_closed());
        assert!(sender.is_closed());
        assert_eq!(replacement.try_recv(), Ok(7));
        assert!(matches!(
            sender.try_send(8),
            Err(async_channel::TrySendError::Closed(8))
        ));
    }

    #[test]
    fn closes_on_early_return_and_unwind() {
        fn initialize(receiver: async_channel::Receiver<()>) -> Result<(), ()> {
            let _close = CloseOnDrop(receiver);
            Err(())
        }
        let (sender, receiver) = async_channel::bounded(1);
        assert!(initialize(receiver.clone()).is_err());
        assert!(sender.is_closed());
        assert!(receiver.is_closed());

        let (sender, receiver) = async_channel::bounded::<()>(1);
        let worker = receiver.clone();
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                let _close = CloseOnDrop(worker);
                panic!("synthetic worker initialization failure");
            }))
            .is_err()
        );
        assert!(sender.is_closed());
        assert!(receiver.is_closed());
    }
}
