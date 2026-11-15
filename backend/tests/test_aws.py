import pytest
from gr2lite.aws_archive import download_kmob, list_kmob_volumes


def test_rejects_bad_dates_without_network():
    with pytest.raises(ValueError):
        list_kmob_volumes("today")


def test_rejects_untrusted_keys_without_network(tmp_path):
    with pytest.raises(ValueError):
        download_kmob("../../etc/passwd", tmp_path)
