import unittest

import image_jobs


class PromptProtocolTests(unittest.TestCase):
    def test_short_requirement_is_wrapped_in_exact_batch_protocol(self):
        prompt = image_jobs.render_prompt(
            '左上角加 2D PRINT；下方加英文钩子。', '毛毯', '{index}', 3
        )
        self.assertIn(image_jobs.PROMPT_PROTOCOL_MARKER, prompt)
        self.assertIn('ZIP 内正好有 3 张', prompt)
        self.assertIn('分别调用 3 次生图工具', prompt)
        self.assertIn('共返回 3 张成品', prompt)
        self.assertIn('不得把多张模板合成一张拼图', prompt)
        self.assertIn('左上角加 2D PRINT', prompt)

    def test_protocol_is_idempotent(self):
        first = image_jobs.render_prompt('keep {category} JSON {"x": 1}', '地垫', 1, 12)
        second = image_jobs.render_prompt(first, '地垫', 1, 12)
        self.assertEqual(first, second)
        self.assertEqual(first.count(image_jobs.PROMPT_PROTOCOL_MARKER), 1)
        self.assertIn('正好有 12 张', first)
        self.assertIn('keep 地垫 JSON {"x": 1}', first)


if __name__ == '__main__':
    unittest.main()
