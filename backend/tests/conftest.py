"""
Shared pytest configuration and fixtures for backend tests.
Run all tests: cd backend && python -m pytest tests/ -v
Run specific:  cd backend && python -m pytest tests/test_greeks.py -v
"""
import sys
import os

# Ensure backend/ is on path for all tests
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
