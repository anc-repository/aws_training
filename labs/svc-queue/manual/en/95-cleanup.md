---
section: cleanup
---

- Both queues are deleted when the session is reclaimed; messages in the dead-letter queue are deleted with it.
- After deletion, a queue with the same name can only be recreated after a while (see the official documentation), so do not `disable` / `enable` repeatedly within the card.
- The memory queue and the worker tier are local settings that go away with the lab instance; nothing to do.
