import os
import unittest

from database import DomainError

# Evita que este test unitario intente abrir el pool configurado en el .env
# local al importar los helpers del servidor.
os.environ["DATABASE_URL"] = ""
os.environ["DATABASE_PUBLIC_URL"] = ""
from server import PBKDF2_ITERATIONS, password_hash, validate_new_password, verify_password


class PasswordSecurityTests(unittest.TestCase):
    def test_password_hash_roundtrip_and_wrong_password(self):
        stored = password_hash("una-clave-segura")
        self.assertTrue(stored.startswith(f"pbkdf2_sha256${PBKDF2_ITERATIONS}$"))
        self.assertTrue(verify_password("una-clave-segura", stored))
        self.assertFalse(verify_password("clave-incorrecta", stored))

    def test_password_policy_requires_minimum_length(self):
        with self.assertRaises(DomainError):
            validate_new_password("corta")
        validate_new_password("diez-carac")


if __name__ == "__main__":
    unittest.main()
