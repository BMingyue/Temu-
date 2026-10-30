import json
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

import image_jobs


class ClearImageJobRecordsTests(unittest.TestCase):
    def write_job(self, root, ident, phase):
        folder = Path(root) / 'image-jobs' / ident
        folder.mkdir(parents=True)
        job = {'id': ident, 'task_no': 'IMG-' + ident, 'batch_phase': phase}
        (folder / 'job.json').write_text(json.dumps(job), encoding='utf-8')
        return folder

    def test_only_finished_records_are_archived(self):
        with TemporaryDirectory() as root:
            saved = self.write_job(root, 'saved', 'saved')
            queued = self.write_job(root, 'queued', 'queued')
            paused = self.write_job(root, 'paused', 'paused')
            result = image_jobs.clear_records(root)
            self.assertEqual(result['cleared'], 1)
            self.assertFalse(saved.exists())
            self.assertTrue(queued.exists())
            self.assertTrue(paused.exists())
            archives = list((Path(root) / 'image-jobs-archive').glob('*-saved/job.json'))
            self.assertEqual(len(archives), 1)


class CompactImageJobTests(unittest.TestCase):
    def test_compact_job_keeps_queue_controls_without_large_manifests(self):
        job = {
            'id': 'a' * 32,
            'task_no': 'IMG-COMPACT',
            'title': 'large task',
            'created': '2026-10-09T00:00:00+00:00',
            'batch_phase': 'failed',
            'sent_at': '2026-10-09T00:01:00+00:00',
            'prompt_template': 'prompt',
            'steps': [{'number': 1, 'prompt': 'large copied prompt'}],
            'fixed_images': [{'source': 'large fixed manifest'}] * 3,
            'logs': [{'event': 'prepared'}, {'event': 'sending'}],
        }

        compact = image_jobs.compact_job(job)

        self.assertEqual(compact['step_count'], 1)
        self.assertEqual(compact['fixed_image_count'], 3)
        self.assertTrue(compact['has_sending_event'])
        self.assertNotIn('steps', compact)
        self.assertNotIn('fixed_images', compact)
        self.assertNotIn('logs', compact)
        self.assertEqual(compact['prompt_template'], 'prompt')


class MultiReferencePreparationTests(unittest.TestCase):
    def write_job(self, root, ident, phase):
        folder = Path(root) / 'image-jobs' / ident
        folder.mkdir(parents=True)
        job = {'id': ident, 'task_no': 'IMG-' + ident, 'batch_phase': phase}
        (folder / 'job.json').write_text(json.dumps(job), encoding='utf-8')
        return folder

    def test_prepare_copies_primary_and_extra_reference_images(self):
        with TemporaryDirectory() as root:
            data = Path(root) / 'data'
            inputs = Path(root) / 'source'
            output = Path(root) / 'output'
            inputs.mkdir()
            primary = inputs / 'primary.png'
            extra_one = inputs / 'back.jpg'
            extra_two = inputs / 'detail.webp'
            primary.write_bytes(b'primary')
            extra_one.write_bytes(b'extra-one')
            extra_two.write_bytes(b'extra-two')
            template = inputs / 'template.zip'
            with zipfile.ZipFile(template, 'w') as archive:
                archive.writestr('template.png', b'template')

            job = image_jobs.prepare({
                'title': 'multi-reference',
                'category': '地垫',
                'prompt': 'use every reference',
                'reference': str(primary),
                'extra_references': [str(extra_one), str(extra_two)],
                'template': str(template),
                'output_folder': str(output),
            }, data)

            self.assertEqual(len(job['reference_images']), 3)
            self.assertEqual(job['reference'], job['reference_images'][0])
            self.assertTrue(all(Path(path).is_file() for path in job['reference_images']))
            self.assertIn('3 张参考图', job['logs'][0]['message'])

    def test_prepare_rejects_more_than_seven_extra_references(self):
        with TemporaryDirectory() as root:
            data = Path(root) / 'data'
            source = Path(root) / 'source'
            source.mkdir()
            primary = source / 'primary.png'
            primary.write_bytes(b'primary')
            template = source / 'template.zip'
            with zipfile.ZipFile(template, 'w') as archive:
                archive.writestr('template.png', b'template')
            extras = []
            for index in range(8):
                path = source / f'extra-{index}.png'
                path.write_bytes(str(index).encode())
                extras.append(str(path))
            with self.assertRaisesRegex(ValueError, '最多 7 张'):
                image_jobs.prepare({
                    'title': 'too-many', 'category': '地垫', 'prompt': 'prompt',
                    'reference': str(primary), 'extra_references': extras,
                    'template': str(template), 'output_folder': str(Path(root) / 'output'),
                }, data)

    def test_batch_delete_selected_removes_inactive_and_protects_active(self):
        with TemporaryDirectory() as root:
            queued_id = 'a' * 32
            paused_id = 'b' * 32
            active_id = 'c' * 32
            queued = self.write_job(root, queued_id, 'queued')
            paused = self.write_job(root, paused_id, 'paused')
            active = self.write_job(root, active_id, 'waiting')

            result = image_jobs.delete_selected(root, [queued_id, paused_id, active_id])

            self.assertEqual(result['deleted'], 2)
            self.assertEqual(len(result['protected']), 1)
            self.assertFalse(queued.exists())
            self.assertFalse(paused.exists())
            self.assertTrue(active.exists())
            self.assertEqual(
                len(list((Path(root) / 'image-jobs-archive').glob('deleted-*-*/job.json'))),
                2,
            )

    def test_batch_delete_selected_keeps_unselected_jobs(self):
        with TemporaryDirectory() as root:
            first_id = 'd' * 32
            second_id = 'e' * 32
            first = self.write_job(root, first_id, 'failed')
            second = self.write_job(root, second_id, 'failed')

            result = image_jobs.delete_selected(root, [first_id])

            self.assertEqual(result['deleted'], 1)
            self.assertFalse(first.exists())
            self.assertTrue(second.exists())

    def test_only_selected_finished_records_are_archived(self):
        with TemporaryDirectory() as root:
            first_id = 'a' * 32
            second_id = 'b' * 32
            first = self.write_job(root, first_id, 'saved')
            second = self.write_job(root, second_id, 'saved')

            result = image_jobs.clear_records(root, [second_id])

            self.assertEqual(result['cleared'], 1)
            self.assertTrue(first.exists())
            self.assertFalse(second.exists())
            archives = list(
                (Path(root) / 'image-jobs-archive').glob(f'*-{second_id}/job.json')
            )
            self.assertEqual(len(archives), 1)


if __name__ == '__main__':
    unittest.main()
