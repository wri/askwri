"""Exercise the real coverage SQL on temporary tables, never corpus writes.

Set CORPUS_MATCH_TEST_DSN to a disposable Postgres database. Temporary tables
shadow public tables and are rolled back after each test.
"""
import json
import os
from contextlib import contextmanager

import psycopg
import pytest

import app.main as main


@pytest.fixture
def corpus(monkeypatch):
    dsn = os.getenv("CORPUS_MATCH_TEST_DSN") or os.getenv("DATABASE_URL")
    if not dsn:
        pytest.skip("CORPUS_MATCH_TEST_DSN not set (disposable Postgres)")
    with psycopg.connect(dsn) as conn:
        conn.execute("""
            CREATE TEMP TABLE documents (
                id integer, title text, title_en text, authors text,
                source_metadata jsonb DEFAULT '{}');
            CREATE TEMP TABLE document_summaries (
                document_id integer, language text, kind text, text text);
            CREATE TEMP TABLE tags (id integer, value_id text);
            CREATE TEMP TABLE tag_aliases (tag_id integer, alias text);
        """)

        class Pool:
            @contextmanager
            def connection(self):
                yield conn

        monkeypatch.setattr("app.db.get_pool", lambda: Pool())
        yield conn
        conn.rollback()


def test_author_name_order_and_punctuation(corpus):
    corpus.execute("INSERT INTO documents (authors) VALUES (%s)",
                   ("Mulukutla, Pawan; Pai, Madhav",))
    assert main.core_topic_in_corpus("Pawan Mulukutla") == {
        "present": True, "matched_term": "Pawan Mulukutla", "matched_surface": "authors",
    }


def test_author_tokens_must_belong_to_one_person(corpus):
    corpus.execute("INSERT INTO documents (authors) VALUES (%s)",
                   ("Pai, Pawan; Mulukutla, Madhav",))
    assert main.core_topic_in_corpus("Pawan Mulukutla")["present"] is False


def test_author_token_matching_does_not_match_partial_names(corpus):
    corpus.execute("INSERT INTO documents (authors) VALUES (%s)",
                   ("Mulukutla, Pawanee",))
    assert main.core_topic_in_corpus("Pawan Mulukutla")["present"] is False


def test_authoritative_summary_rescues_title_miss(corpus):
    corpus.execute("INSERT INTO documents (id, title) VALUES (1, 'Container operations')")
    corpus.execute("INSERT INTO document_summaries VALUES (1, 'en', 'long', %s)",
                   ("The study examines Yantian Port mode shift targets.",))
    result = main.core_topic_in_corpus("Yantian Port")
    assert result == {"present": True, "matched_term": "Yantian Port", "matched_surface": "summary"}


def test_legacy_summary_fallback(corpus):
    corpus.execute("INSERT INTO documents (id, source_metadata) VALUES (1, %s)",
                   (json.dumps({"summary": "Transport revenue from carbon tax measures"}),))
    assert main.core_topic_in_corpus("carbon tax")["matched_surface"] == "summary"


def test_current_summary_takes_precedence_over_stale_import(corpus):
    corpus.execute("INSERT INTO documents (id, source_metadata) VALUES (1, %s)",
                   (json.dumps({"summary": "urban vertical farming"}),))
    corpus.execute("INSERT INTO document_summaries VALUES (1, 'en', 'long', 'Public transport')")
    assert main.core_topic_in_corpus("vertical farming")["present"] is False


@pytest.mark.parametrize("topic", [
    "surveillance technologies",
    "using surveillance technologies to increase climate resilience in cities",
    "urban vertical farming or rooftop agriculture",
    "urban vertical farming or rooftop agriculture in cities",
])
def test_negative_extraction_variants_cannot_match_purpose_or_location(corpus, topic):
    corpus.execute("INSERT INTO documents (title) VALUES ('Climate resilience in cities')")
    assert main.core_topic_in_corpus(topic)["present"] is False


@pytest.mark.parametrize("topic", ["bike-sharing in China", "housing crisis in Jakarta"])
def test_substantive_geography_is_not_stripped(corpus, topic):
    corpus.execute("INSERT INTO documents (title) VALUES (%s)", (topic,))
    assert main.core_topic_in_corpus(topic)["present"] is True


def test_like_wildcards_in_topic_are_literal(corpus):
    corpus.execute("INSERT INTO documents (title) VALUES ('urban farming')")
    assert main.core_topic_in_corpus("urban%farming")["present"] is False
