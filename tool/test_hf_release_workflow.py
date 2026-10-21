"""HF-SEC-RELEASE-1 workflow contract; execute only in authorized CI.

No YAML dependency: checks deliberately target the workflow's indentation and
extract its actual release guard, exercising it without SDKs or credentials.
"""
from pathlib import Path
import os
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/hf-flutter.yml").read_text()


def step(name):
    marker = "      - name: " + name + "\n"
    return WORKFLOW.split(marker, 1)[1].split("\n      - ", 1)[0]


class ReleaseWorkflowContract(unittest.TestCase):
    def test_dispatch_defaults_to_live(self):
        demo = WORKFLOW.split("      demo:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertIn("default: 'false'", demo)
        self.assertIn("options: ['true', 'false']", demo)
        self.assertIn("HF_DEMO: ${{ inputs.demo || 'false' }}", WORKFLOW)
        triggers = WORKFLOW.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertEqual(re.findall(r"^  ([a-z_]+):", triggers, re.M), ["workflow_dispatch"])

    def test_guard_precedes_build_tools_and_publication(self):
        guard = WORKFLOW.index("      - name: Guard - release mode\n")
        self.assertNotIn("if:", step("Guard - release mode"))
        self.assertNotIn("continue-on-error", step("Guard - release mode"))
        for marker in ("actions/setup-java", "Set up Flutter", "Build APK", "Build AAB", "Build unsigned release", "Upload APK", "Upload AAB", "Publish AAB to Play"):
            self.assertLess(guard, WORKFLOW.index(marker))

    def test_actual_guard_mode_matrix(self):
        block = step("Guard - release mode").split("        run: |\n", 1)[1]
        script = "\n".join(line[10:] for line in block.splitlines() if line.strip())
        for mode in ("check", "buildcheck", "apk", "aab", "internal", "scaffold"):
            for demo in ("true", "false", "", "invalid"):
                with self.subTest(mode=mode, demo=demo):
                    result = subprocess.run(
                        ["bash", "-e", "-c", script],
                        env={**os.environ, "MODE": mode, "HF_DEMO": demo},
                        capture_output=True, text=True,
                    )
                    allowed = demo in ("true", "false") and not (mode == "internal" and demo == "true")
                    self.assertEqual(result.returncode == 0, allowed, result.stdout + result.stderr)

    def test_builds_use_resolved_mode_and_tests_keep_demo_fixtures(self):
        for name in ("Build APK (arm64)", "Build AAB", "Build unsigned release (buildcheck)"):
            self.assertIn('--dart-define=HF_DEMO="${HF_DEMO}"', step(name))
        self.assertNotIn("--dart-define=HF_DEMO", step("Test"))
        self.assertIn("if: env.MODE == 'internal'", step("Publish AAB to Play (internal track)"))
        self.assertIn("if: always()", step("Summary"))
        for field in ("${GITHUB_SHA}", "${MODE}", "${HF_DEMO}"):
            self.assertIn(field, step("Summary"))


if __name__ == "__main__":
    unittest.main()
