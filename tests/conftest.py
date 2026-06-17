"""Make the project root importable so tests can `import app`, `providers`, etc."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
