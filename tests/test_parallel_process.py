import multiprocessing
import queue
import unittest

from main import AppConfig, _parallel_worker_process


class ParallelWorkerProcessTests(unittest.TestCase):
    def test_worker_can_spawn_with_independent_playwright_driver(self):
        context = multiprocessing.get_context("spawn")
        work_queue = context.Queue()
        result_queue = context.Queue()
        abort_event = context.Event()
        finish_event = context.Event()
        state_lock = context.RLock()
        process = context.Process(
            target=_parallel_worker_process,
            args=(
                1,
                1,
                "http://127.0.0.1:1",
                AppConfig().__dict__,
                work_queue,
                result_queue,
                abort_event,
                finish_event,
                state_lock,
                2,
                1,
                "state-never-written.json",
            ),
        )
        process.start()
        process.join(timeout=20)
        if process.is_alive():
            process.terminate()
            process.join(timeout=5)
            self.fail("parallel worker did not exit after connection failure")
        self.assertEqual(process.exitcode, 0)

        message_types = []
        while True:
            try:
                message_types.append(result_queue.get_nowait()["type"])
            except queue.Empty:
                break
        self.assertIn("worker_fatal", message_types)
        self.assertIn("worker_done", message_types)


if __name__ == "__main__":
    unittest.main()
