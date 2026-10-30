"""Template readiness regressions. Browser tests use offline DOMs, never publish."""
import re
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from main import (
    AppConfig, DxmUploader, ProductJob, RunReport, StopRequested,
    TemplateValidationError, UploaderApp, find_browser,
)


class TemplateFlowTests(unittest.TestCase):
    def setUp(self):
        self.uploader = DxmUploader(AppConfig(operation_timeout_seconds=5), lambda _: None, threading.Event())
        self.uploader.page = MagicMock()
        self.uploader.page.is_closed.return_value = False
        self.elapsed = 0
        self.clock = patch('main.time.monotonic', lambda: self.elapsed)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.uploader._sleep = lambda seconds: setattr(self, 'elapsed', self.elapsed + seconds)

    def test_partial_data_waits_for_two_stable_ready_checks(self):
        self.uploader._template_problems = MagicMock(side_effect=[['missing'], [], ['loading'], [], []])
        self.uploader._wait_for_template_data()
        self.assertEqual(5, self.uploader._template_problems.call_count)

    def test_empty_template_times_out_and_cannot_retry(self):
        self.uploader._template_problems = MagicMock(return_value=['店铺账号未加载或未选择'])
        with self.assertRaises(TemplateValidationError) as caught:
            self.uploader._wait_for_template_data()
        self.assertEqual(5, self.elapsed)
        self.assertIn('店铺账号', str(caught.exception))
        self.assertFalse(self.uploader._should_retry_job(ProductJob(Path('x'), 'Safe title', []), caught.exception, 1))

    def test_stop_is_responsive_during_template_wait(self):
        self.uploader.stopped.set()
        with self.assertRaises(StopRequested):
            self.uploader._wait_for_template_data()

    def test_closed_browser_stops(self):
        self.uploader.page.is_closed.return_value = True
        with self.assertRaises(StopRequested):
            self.uploader._wait_for_template_data()

    def test_template_check_runs_after_editor_before_mutation(self):
        calls = []
        self.uploader._wait_for_editor = lambda: calls.append('editor')
        self.uploader._wait_for_template_data = lambda: calls.append('template')
        self.uploader._open_template()
        self.assertEqual(['editor', 'template'], calls)

    def test_shared_failure_stops_entire_batch_without_upload_or_state_change(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            jobs = [ProductJob(root / name, name, []) for name in ['Safe A', 'Safe B', 'Safe C']]
            state = MagicMock()
            state.is_completed.return_value = False
            context = MagicMock()
            context.pages = [self.uploader.page]
            runtime = MagicMock()
            runtime.__enter__.return_value.chromium.launch_persistent_context.return_value = context
            self.uploader.config.publish_mode = 'schedule'
            self.uploader.config.concurrent_pages = 1
            self.uploader._open_template = MagicMock(side_effect=TemplateValidationError('空模板'))
            self.uploader._fill_title = MagicMock()
            self.uploader._upload_carousel = MagicMock()
            self.uploader._schedule_publish = MagicMock()
            self.uploader._capture_failure = MagicMock(return_value=root / 'evidence')
            with patch('playwright.sync_api.sync_playwright', return_value=runtime), \
                    patch('main.find_browser', return_value='unused'), \
                    patch('main.StateStore', return_value=state), \
                    patch('main.PROFILE_DIR', root / 'profile'), patch('main.LOG_DIR', root / 'logs'):
                report = self.uploader.run(jobs)
            self.assertEqual((0, 0, 3), (report.attempted, report.succeeded, report.pending_count))
            self.assertEqual([], report.failures)
            self.assertTrue(report.blocked_reason)
            self.assertTrue(report.report_path.exists())
            self.uploader._open_template.assert_called_once()
            self.uploader._fill_title.assert_not_called()
            self.uploader._upload_carousel.assert_not_called()
            self.uploader._schedule_publish.assert_not_called()
            state.mark_completed.assert_not_called()
            context.close.assert_called_once()
            self.assertFalse(UploaderApp._offer_failed_batch_recovery(MagicMock(), report, jobs))

    def test_batch_mode_dispatches_to_three_page_concurrent_runner(self):
        jobs = [
            ProductJob(Path(f'Product {index}'), f'Product {index}', [])
            for index in range(1, 4)
        ]
        state = MagicMock()
        state.is_completed.return_value = False
        expected = RunReport(attempted=3, succeeded=3, failures=[])
        self.uploader.config.publish_mode = 'schedule'
        self.uploader.config.concurrent_pages = 3
        self.uploader._run_concurrent = MagicMock(return_value=expected)

        with patch('main.find_browser', return_value='browser.exe'), \
                patch('main.StateStore', return_value=state):
            report = self.uploader.run(jobs)

        self.assertIs(report, expected)
        args = self.uploader._run_concurrent.call_args.args
        self.assertEqual(args[0], jobs)
        self.assertIs(args[1], state)
        self.assertEqual(args[2], 0)
        self.assertEqual(args[3], 'browser.exe')


class OfflineTemplateDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.runtime = sync_playwright().start()
        cls.browser = cls.runtime.chromium.launch(
            executable_path=find_browser(AppConfig.load().browser_path), headless=True,
        )
        cls.context = cls.browser.new_context(service_workers='block')
        cls.context.route('**/*', lambda route: route.abort())
        cls.page = cls.context.new_page()
        cls.uploader = DxmUploader(AppConfig(), lambda _: None, threading.Event())
        cls.uploader.page = cls.page

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.runtime.stop()

    def load_html(self, html):
        # Strip scripts in saved evidence so it cannot run application code;
        # network is also blocked for CSS, images, frames and all other requests.
        html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S | re.I)
        self.page.set_content(html, wait_until='domcontentloaded')

    def test_all_three_actual_failed_pages_are_rejected(self):
        root = Path(__file__).resolve().parents[1]
        paths = list((root / 'logs').glob('20260904-165*/page.html'))
        if not paths:
            self.skipTest('Local failure evidence is not present')
        self.assertEqual(3, len(paths))
        for path in paths:
            with self.subTest(path=path.parent.name):
                self.load_html(path.read_text(encoding='utf-8'))
                problems = self.uploader._template_problems()
                self.assertEqual(4, len(problems), problems)
                self.assertTrue(any('变种' in issue for issue in problems))

    def test_previous_populated_template_passes(self):
        root = Path(__file__).resolve().parents[1]
        paths = sorted((root / 'logs').glob('20260903*/page.html'))
        if not paths:
            self.skipTest('Local populated template evidence is not present')
        self.load_html(paths[-1].read_text(encoding='utf-8'))
        self.assertEqual([], self.uploader._template_problems())

    def test_hidden_selected_values_and_unrelated_table_do_not_pass(self):
        self.load_html('''
            <div class="ant-form-item"><label title="店铺账号">店铺账号</label>
                <span class="ant-select-selection-item" style="display:none">old shop</span></div>
            <div class="ant-form-item"><label title="产品分类">产品分类</label>
                <span class="ant-select-selection-item">请选择分类</span></div>
            <div class="ant-form-item"><label title="运费模板">运费模板</label></div>
            <table><thead><tr><th>SKU分类(批量)</th></tr></thead><tbody><tr><td><input></td></tr></tbody></table>
            <table style="display:none"><thead><tr><th>预览图(批量)</th></tr></thead>
                <tbody><tr><td><input></td></tr></tbody></table>
        ''')
        self.assertEqual(4, len(self.uploader._template_problems()))

    def test_valid_selected_fields_with_empty_search_inputs_pass(self):
        self.load_html(''.join(
            f'<div class="ant-form-item"><label title="{name}">{name}</label>'
            '<input value=""><span class="ant-select-selection-item">selected value</span></div>'
            for name in ['店铺账号', '产品分类', '运费模板']
        ) + '<table><thead><tr><th>预览图(批量)</th></tr></thead><tbody><tr><td><input></td></tr></tbody></table>')
        self.assertEqual([], self.uploader._template_problems())


if __name__ == '__main__':
    unittest.main()
