# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "marimo",
#     "pandas",
#     "altair",
#     "scikit-learn==1.8.0",
#     "numpy==2.4.3",
# ]
# ///

import marimo

__generated_with = "0.21.1"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo

    return (mo,)


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    # Answer Mode Score Distribution Analysis

    Explores raw cross-encoder logit scores and normalized scores for retrieved
    **passages** (chunks), split by whether each passage is a known-relevant result
    from the Answer mode golden set.

    Relevance is labeled at two levels:
    - **Exact** — chunk_id is directly listed in the golden set expected passages
    - **Adjacent** — chunk_id is within ±1 of a golden expected chunk (accounts for
      chunking boundary ambiguity, consistent with `run-answer-retrieval-eval.ts`)

    **Run the data collection script first:**
    ```
    npx tsx --env-file-if-exists=.env evaluation/score_distribution_analysis_answer.ts
    ```
    Then select the resulting `results/answer-score-distribution-<timestamp>.json` below.
    """)
    return


@app.cell(hide_code=True)
def _():
    import glob
    import json
    import os
    import pandas as pd
    import altair as alt

    return alt, glob, json, os, pd


@app.cell(hide_code=True)
def _(glob, os):
    results_dir = os.path.join(os.path.dirname(__file__), "results")
    available_files = sorted(
        glob.glob(os.path.join(results_dir, "answer-score-distribution-*.json"))
    )
    available_files
    return (available_files,)


@app.cell(hide_code=True)
def _(available_files, mo, os):
    if not available_files:
        file_picker = mo.md("""
        **No result files found.**

        Run the data collection script first:
        ```
        npx tsx --env-file-if-exists=.env evaluation/score_distribution_analysis_answer.ts
        ```
        """)
    else:
        file_picker = mo.ui.dropdown(
            options={os.path.basename(f): f for f in available_files},
            value=os.path.basename(available_files[-1]),
            label="Score distribution file",
        )
    file_picker
    return (file_picker,)


@app.cell(hide_code=True)
def _(available_files, file_picker, json, pd):
    if not available_files:
        df = pd.DataFrame()
        raw = {}
    else:
        with open(file_picker.value) as f:
            raw = json.load(f)

        rows = []
        for query in raw["queries"]:
            for passage in query["passages"]:
                rows.append(
                    {
                        "query_id": query["query_id"],
                        "question": query["question"],
                        "query_type": query["query_type"],
                        "difficulty": query["difficulty"],
                        "rank": passage["rank"],
                        "chunk_id": passage["chunk_id"],
                        "doc_id": passage["doc_id"],
                        "title": passage["title"],
                        "page": passage["page"],
                        "normalized_score": passage["normalized_score"],
                        "raw_logit": passage["raw_logit"],
                        "is_relevant": passage["is_relevant"],
                        "is_adjacent_relevant": passage["is_adjacent_relevant"],
                    }
                )

        df = pd.DataFrame(rows)
        if not df.empty:
            df["rank"] = df["rank"].astype(int)
            df["normalized_score"] = df["normalized_score"].astype(float)
            df["raw_logit"] = pd.to_numeric(df["raw_logit"], errors="coerce")
            df["is_relevant"] = df["is_relevant"].astype(bool)
            df["is_adjacent_relevant"] = df["is_adjacent_relevant"].astype(bool)
            df["relevance"] = df["is_relevant"].map(
                {True: "Relevant (exact)", False: "Not relevant"}
            )
            df.loc[~df["is_relevant"] & df["is_adjacent_relevant"], "relevance"] = (
                "Relevant (adjacent)"
            )

        print(
            f"Loaded {len(df)} rows — {df['query_id'].nunique()} queries, "
            f"{df['is_relevant'].sum()} exact-relevant / "
            f"{(df['is_adjacent_relevant'] & ~df['is_relevant']).sum()} adjacent-only / "
            f"{(~df['is_adjacent_relevant']).sum()} not-relevant"
        )
        df.head()
    return df, raw


@app.cell(hide_code=True)
def _(available_files, mo, raw):
    if available_files:
        s = raw["summary"]
        mo.md(f"""
        **Run metadata**
        Generated: `{raw["generated_at"]}`
        Service: `{raw["service_url"]}`
        Golden dataset: `{raw["golden_dataset"]}`
        Params: max\\_results={raw["params"]["max_results"]}, rerank\\_top\\_n={raw["params"]["rerank_top_n"]}, adjacent\\_tolerance=±{raw["params"]["adjacent_tolerance"]}

        | Queries | Passages retrieved | Exact relevant | Adjacent relevant | Expected passages | Exact recall@{raw["params"]["max_results"]} | Adjacent recall@{raw["params"]["max_results"]} |
        |---------|-------------------|----------------|-------------------|-------------------|------|------|
        | {s["total_queries"]} | {s["total_passages_retrieved"]} | {s["total_relevant_retrieved_exact"]} | {s["total_relevant_retrieved_adjacent"]} | {s["total_expected_passages"]} | {s["overall_recall_exact_at_max"]:.1%} | {s["overall_recall_adjacent_at_max"]:.1%} |
        """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Raw logit distribution — by relevance label
    """)
    return


@app.cell(hide_code=True)
def _(alt, available_files, df):
    COLOR_SCALE = alt.Scale(
        domain=["Relevant (exact)", "Relevant (adjacent)", "Not relevant"],
        range=["#22c55e", "#86efac", "#94a3b8"],
    )

    if not available_files or df.empty:
        logit_charts = None
    else:
        logit_base = alt.Chart(df.dropna(subset=["raw_logit"]))

        logit_hist = (
            logit_base.mark_bar(opacity=0.6, binSpacing=0)
            .encode(
                alt.X("raw_logit:Q", bin=alt.Bin(maxbins=40), title="Raw logit"),
                alt.Y("count():Q", stack=None, title="Count"),
                alt.Color("relevance:N", scale=COLOR_SCALE),
                tooltip=["relevance:N", "count():Q"],
            )
            .properties(title="Raw logit histogram", width=380, height=280)
        )

        def logit_kde_layer(relevance, color):
            return (
                logit_base.transform_filter(alt.datum.relevance == relevance)
                .transform_density("raw_logit", as_=["raw_logit", "density"])
                .mark_area(opacity=0.4, color=color)
                .encode(
                    alt.X("raw_logit:Q", title="Raw logit"),
                    alt.Y("density:Q", title="Density"),
                    tooltip=[
                        alt.Tooltip("raw_logit:Q", format=".2f"),
                        alt.Tooltip("density:Q", format=".4f"),
                    ],
                )
            )

        logit_kde = alt.layer(
            logit_kde_layer("Not relevant", "#94a3b8"),
            logit_kde_layer("Relevant (adjacent)", "#86efac"),
            logit_kde_layer("Relevant (exact)", "#22c55e"),
        ).properties(title="Raw logit KDE", width=380, height=280)

        logit_charts = (logit_hist | logit_kde).resolve_scale(y="independent")

    logit_charts
    return (COLOR_SCALE,)


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Normalized score distribution — by relevance label
    """)
    return


@app.cell(hide_code=True)
def _(COLOR_SCALE, alt, available_files, df):
    if not available_files or df.empty:
        norm_charts = None
    else:
        norm_base = alt.Chart(df.dropna(subset=["normalized_score"]))

        norm_hist = (
            norm_base.mark_bar(opacity=0.6, binSpacing=0)
            .encode(
                alt.X(
                    "normalized_score:Q",
                    bin=alt.Bin(maxbins=40),
                    title="Normalized score",
                ),
                alt.Y("count():Q", stack=None, title="Count"),
                alt.Color("relevance:N", scale=COLOR_SCALE),
                tooltip=["relevance:N", "count():Q"],
            )
            .properties(title="Normalized score histogram", width=380, height=280)
        )

        def norm_kde_layer(relevance, color):
            return (
                norm_base.transform_filter(alt.datum.relevance == relevance)
                .transform_density(
                    "normalized_score", as_=["normalized_score", "density"]
                )
                .mark_area(opacity=0.4, color=color)
                .encode(
                    alt.X("normalized_score:Q", title="Normalized score"),
                    alt.Y("density:Q", title="Density"),
                    tooltip=[
                        alt.Tooltip("normalized_score:Q", format=".2f"),
                        alt.Tooltip("density:Q", format=".4f"),
                    ],
                )
            )

        norm_kde = alt.layer(
            norm_kde_layer("Not relevant", "#94a3b8"),
            norm_kde_layer("Relevant (adjacent)", "#86efac"),
            norm_kde_layer("Relevant (exact)", "#22c55e"),
        ).properties(title="Normalized score KDE", width=380, height=280)

        norm_charts = (norm_hist | norm_kde).resolve_scale(y="independent")

    norm_charts
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Per-query breakdown
    """)
    return


@app.cell(hide_code=True)
def _(available_files, df):
    if not available_files or df.empty:
        per_query = None
    else:
        per_query = (
            df.groupby(["query_id", "query_type", "difficulty", "relevance"])[
                "raw_logit"
            ]
            .agg(["count", "min", "median", "max"])
            .round(2)
            .reset_index()
        )
        per_query.columns = [
            "query_id",
            "query_type",
            "difficulty",
            "relevance",
            "count",
            "min_logit",
            "median_logit",
            "max_logit",
        ]
    per_query
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Descriptive statistics by relevance
    """)
    return


@app.cell(hide_code=True)
def _(available_files, df):
    if not available_files or df.empty:
        desc = None
    else:
        desc = (
            df.groupby("relevance")[["raw_logit", "normalized_score"]]
            .describe()
            .round(3)
        )
    desc
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Per-query threshold explorer

    The red dashed line shows the current threshold applied to the raw logit.
    The downstream synthesis route applies `RELEVANCE_THRESHOLD = 0.75` on the
    **normalized** score — the second chart shows where that maps to.
    """)
    return


@app.cell(hide_code=True)
def _(available_files, df, mo):
    if not available_files or df.empty:
        threshold_slider = mo.md("*(no data)*")
    else:
        logit_min = float(df["raw_logit"].min())
        logit_max = float(df["raw_logit"].max())
        threshold_slider = mo.ui.slider(
            start=round(logit_min, 1),
            stop=round(logit_max, 1),
            step=0.1,
            value=0.0,
            label="Logit floor threshold",
            show_value=True,
        )
    threshold_slider
    return (threshold_slider,)


@app.cell(hide_code=True)
def _(available_files, df, mo):
    if not available_files or df.empty:
        query_picker = mo.md("*(no data)*")
    else:
        query_options = {
            f"{row['query_id']} — {row['question'][:60]}": row["query_id"]
            for row in df[["query_id", "question"]].drop_duplicates().to_dict("records")
        }
        query_picker = mo.ui.dropdown(
            options=query_options,
            value=list(query_options.keys())[0],
            label="Query",
        )
    query_picker
    return (query_picker,)


@app.cell(hide_code=True)
def _(
    COLOR_SCALE,
    alt,
    available_files,
    df,
    mo,
    query_picker,
    threshold_slider,
):
    if not available_files or df.empty:
        per_query_chart = mo.md("*(no data)*")
        stats = mo.md("")
        threshold = 0.0
    else:
        threshold = threshold_slider.value
        query_id = query_picker.value
        query_df = df[df["query_id"] == query_id].dropna(subset=["raw_logit"])

        n_total = len(query_df)
        n_relevant = int(query_df["is_relevant"].sum())
        n_adjacent = int(query_df["is_adjacent_relevant"].sum())
        n_surviving = int((query_df["raw_logit"] >= threshold).sum())
        n_rel_surviving = int(
            (query_df["is_relevant"] & (query_df["raw_logit"] >= threshold)).sum()
        )
        n_adj_surviving = int(
            (
                query_df["is_adjacent_relevant"] & (query_df["raw_logit"] >= threshold)
            ).sum()
        )
        recall_exact = n_rel_surviving / n_relevant if n_relevant > 0 else 0.0
        recall_adj = n_adj_surviving / n_adjacent if n_adjacent > 0 else 0.0
        precision = n_rel_surviving / n_surviving if n_surviving > 0 else 0.0

        logit_hist_q = (
            alt.Chart(query_df)
            .mark_bar(opacity=0.6, binSpacing=0)
            .encode(
                alt.X("raw_logit:Q", bin=alt.Bin(maxbins=30), title="Raw logit"),
                alt.Y("count():Q", stack=None, title="Count"),
                alt.Color("relevance:N", scale=COLOR_SCALE),
                tooltip=["relevance:N", "count():Q"],
            )
            .properties(title="Raw logit", width=700, height=200)
        )

        threshold_rule = (
            alt.Chart({"values": [{"threshold": threshold}]})
            .mark_rule(color="#ef4444", strokeDash=[6, 3], strokeWidth=2)
            .encode(alt.X("threshold:Q"))
        )

        norm_hist_q = (
            alt.Chart(query_df)
            .mark_bar(opacity=0.6, binSpacing=0)
            .encode(
                alt.X(
                    "normalized_score:Q",
                    bin=alt.Bin(maxbins=30),
                    title="Normalized score",
                ),
                alt.Y("count():Q", stack=None, title="Count"),
                alt.Color("relevance:N", scale=COLOR_SCALE),
                tooltip=["relevance:N", "count():Q"],
            )
            .properties(title="Normalized score", width=700, height=200)
        )

        per_query_chart = alt.vconcat(logit_hist_q + threshold_rule, norm_hist_q)

        stats = mo.md(f"""
        | | Count |
        |---|---|
        | Total passages retrieved | {n_total} |
        | Exact-relevant passages | {n_relevant} |
        | Adjacent-relevant passages | {n_adjacent} |
        | Surviving threshold | {n_surviving} |
        | Exact-relevant surviving | {n_rel_surviving} |
        | Adjacent-relevant surviving | {n_adj_surviving} |
        | **Exact recall** | **{recall_exact:.0%}** |
        | **Adjacent recall** | **{recall_adj:.0%}** |
        | **Precision (exact)** | **{precision:.0%}** |
        """)

    mo.vstack([per_query_chart])
    return stats, threshold


@app.cell(hide_code=True)
def _(COLOR_SCALE, alt, available_files, df, mo, threshold_slider):
    if not available_files or df.empty:
        all_chart = mo.md("*(no data)*")
        all_stats = mo.md("")
    else:
        all_threshold = threshold_slider.value
        all_df = df.dropna(subset=["raw_logit"])

        all_n_total = len(all_df)
        all_n_relevant = int(all_df["is_relevant"].sum())
        all_n_adjacent = int(all_df["is_adjacent_relevant"].sum())
        all_n_surviving = int((all_df["raw_logit"] >= all_threshold).sum())
        all_n_rel_surviving = int(
            (all_df["is_relevant"] & (all_df["raw_logit"] >= all_threshold)).sum()
        )
        all_n_adj_surviving = int(
            (
                all_df["is_adjacent_relevant"] & (all_df["raw_logit"] >= all_threshold)
            ).sum()
        )
        all_recall_exact = (
            all_n_rel_surviving / all_n_relevant if all_n_relevant > 0 else 0.0
        )
        all_recall_adj = (
            all_n_adj_surviving / all_n_adjacent if all_n_adjacent > 0 else 0.0
        )
        all_precision = (
            all_n_rel_surviving / all_n_surviving if all_n_surviving > 0 else 0.0
        )

        all_hist = (
            alt.Chart(all_df)
            .mark_bar(opacity=0.6, binSpacing=0)
            .encode(
                alt.X("raw_logit:Q", bin=alt.Bin(maxbins=40), title="Raw logit"),
                alt.Y("count():Q", stack=None, title="Count"),
                alt.Color("relevance:N", scale=COLOR_SCALE),
                tooltip=["relevance:N", "count():Q"],
            )
            .properties(title="All queries — raw logit", width=700, height=280)
        )

        all_threshold_rule = (
            alt.Chart({"values": [{"threshold": all_threshold}]})
            .mark_rule(color="#ef4444", strokeDash=[6, 3], strokeWidth=2)
            .encode(alt.X("threshold:Q"))
        )

        all_chart = all_hist + all_threshold_rule

        all_stats = mo.md(f"""
        | | Count |
        |---|---|
        | Total passages retrieved | {all_n_total} |
        | Exact-relevant passages | {all_n_relevant} |
        | Adjacent-relevant passages | {all_n_adjacent} |
        | Surviving threshold | {all_n_surviving} |
        | Exact-relevant surviving | {all_n_rel_surviving} |
        | Adjacent-relevant surviving | {all_n_adj_surviving} |
        | **Exact recall** | **{all_recall_exact:.0%}** |
        | **Adjacent recall** | **{all_recall_adj:.0%}** |
        | **Precision (exact)** | **{all_precision:.0%}** |
        """)

    mo.vstack([all_chart])
    return (all_stats,)


@app.cell(hide_code=True)
def _(all_stats, available_files, mo, query_picker, stats, threshold):
    if available_files:
        mo.vstack(
            [
                mo.md(
                    f"Applying the following value as threshold: **{threshold:.1f}**"
                ),
                mo.hstack(
                    [
                        mo.md(f"**For query '{query_picker.value}'**"),
                        mo.md("**For all queries**"),
                    ],
                    justify="center",
                    widths="equal",
                ),
                mo.hstack(
                    [stats, all_stats],
                    justify="center",
                ),
            ]
        )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## PR and ROC curves

    Computed using **exact** relevance labels (is_relevant).
    The adjacent label inflates coverage slightly; exact is the stricter baseline for AUC.
    """)
    return


@app.cell(hide_code=True)
def _(available_files, df, pd):
    if not available_files or df.empty:
        pr_curve_df = pd.DataFrame()
        roc_curve_df = pd.DataFrame()
        pr_auc = 0.0
        roc_auc = 0.0
    else:
        from sklearn.metrics import precision_recall_curve, roc_curve, auc

        curve_df = df.dropna(subset=["raw_logit"]).copy()
        y_true = curve_df["is_relevant"].astype(int).values
        y_score = curve_df["raw_logit"].values

        pr_precision, pr_recall, pr_thresholds = precision_recall_curve(y_true, y_score)
        pr_auc = auc(pr_recall, pr_precision)

        fpr, tpr, roc_thresholds = roc_curve(y_true, y_score)
        roc_auc = auc(fpr, tpr)

        pr_curve_df = pd.DataFrame(
            {
                "recall": pr_recall[:-1],
                "precision": pr_precision[:-1],
                "threshold": pr_thresholds,
            }
        )

        roc_curve_df = pd.DataFrame(
            {
                "fpr": fpr,
                "tpr": tpr,
                "threshold": roc_thresholds,
            }
        )
    return pr_auc, pr_curve_df, roc_auc, roc_curve_df


@app.cell(hide_code=True)
def _(
    alt,
    available_files,
    mo,
    pr_auc,
    pr_curve_df,
    roc_auc,
    roc_curve_df,
    threshold_slider,
):
    if not available_files or pr_curve_df.empty:
        pr_roc_charts = mo.md("*(no data)*")
    else:
        _threshold = threshold_slider.value

        _pr_op_idx = (pr_curve_df["threshold"] - _threshold).abs().idxmin()
        _pr_op = pr_curve_df.loc[[_pr_op_idx], ["recall", "precision", "threshold"]]

        _roc_op_idx = (roc_curve_df["threshold"] - _threshold).abs().idxmin()
        _roc_op = roc_curve_df.loc[[_roc_op_idx], ["fpr", "tpr", "threshold"]]

        pr_line = (
            alt.Chart(pr_curve_df)
            .mark_line(color="#6366f1", strokeWidth=2)
            .encode(
                alt.X("recall:Q", scale=alt.Scale(domain=[0, 1]), title="Recall"),
                alt.Y("precision:Q", scale=alt.Scale(domain=[0, 1]), title="Precision"),
                tooltip=[
                    alt.Tooltip("threshold:Q", format=".2f", title="Threshold"),
                    alt.Tooltip("precision:Q", format=".3f"),
                    alt.Tooltip("recall:Q", format=".3f"),
                ],
            )
        )

        pr_point = (
            alt.Chart(_pr_op)
            .mark_point(color="#ef4444", size=100, filled=True)
            .encode(
                alt.X("recall:Q"),
                alt.Y("precision:Q"),
                tooltip=[
                    alt.Tooltip("threshold:Q", format=".2f", title="Threshold"),
                    alt.Tooltip("precision:Q", format=".3f"),
                    alt.Tooltip("recall:Q", format=".3f"),
                ],
            )
        )

        pr_chart = (pr_line + pr_point).properties(
            title=alt.TitleParams(
                f"Raw Logit Precision-Recall  (AUC = {pr_auc:.3f})",
                subtitle="Red dot = current threshold",
            ),
            width=340,
            height=300,
        )

        roc_line = (
            alt.Chart(roc_curve_df)
            .mark_line(color="#6366f1", strokeWidth=2)
            .encode(
                alt.X(
                    "fpr:Q", scale=alt.Scale(domain=[0, 1]), title="False positive rate"
                ),
                alt.Y(
                    "tpr:Q", scale=alt.Scale(domain=[0, 1]), title="True positive rate"
                ),
                tooltip=[
                    alt.Tooltip("threshold:Q", format=".2f", title="Threshold"),
                    alt.Tooltip("fpr:Q", format=".3f", title="FPR"),
                    alt.Tooltip("tpr:Q", format=".3f", title="TPR"),
                ],
            )
        )

        roc_diagonal = (
            alt.Chart({"values": [{"x": 0, "y": 0}, {"x": 1, "y": 1}]})
            .mark_line(color="#cbd5e1", strokeDash=[4, 4])
            .encode(alt.X("x:Q"), alt.Y("y:Q"))
        )

        roc_point = (
            alt.Chart(_roc_op)
            .mark_point(color="#ef4444", size=100, filled=True)
            .encode(
                alt.X("fpr:Q"),
                alt.Y("tpr:Q"),
                tooltip=[
                    alt.Tooltip("threshold:Q", format=".2f", title="Threshold"),
                    alt.Tooltip("fpr:Q", format=".3f", title="FPR"),
                    alt.Tooltip("tpr:Q", format=".3f", title="TPR"),
                ],
            )
        )

        roc_chart = (roc_diagonal + roc_line + roc_point).properties(
            title=alt.TitleParams(
                f"Raw Logit ROC  (AUC = {roc_auc:.3f})",
                subtitle="Red dot = current threshold",
            ),
            width=340,
            height=300,
        )

        pr_roc_charts = mo.hstack([pr_chart, roc_chart], justify="center")

    pr_roc_charts
    return


@app.cell(hide_code=True)
def _(available_files, threshold_slider):
    # Re-expose slider below the PR/ROC charts so it stays visible while scrolling
    if available_files:
        threshold_slider
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md(r"""
    ## Threshold recommendations

    Sweeps the PR curve to suggest logit floor thresholds.

    - **Synthesis floor** — most aggressive threshold that keeps exact recall ≥ 80%.
      Use this as `ANSWER_LOGIT_FLOOR` to filter passages before sending to the LLM.
    - **High-precision floor** — highest-precision threshold that keeps exact recall ≥ 50%.
      Useful for strict synthesis where noise hurts answer quality more than coverage.
    - **F1-optimal** — maximises F1 score; shown for reference.

    Note: the current synthesis route does not apply a logit floor — it uses a
    normalized-score threshold (`RELEVANCE_THRESHOLD = 0.75` in `src/app/api/answer/route.ts`).
    These recommendations are for calibrating whether to introduce one.
    """)
    return


@app.cell(hide_code=True)
def _(available_files, mo, pr_curve_df):
    if not available_files or pr_curve_df.empty:
        threshold_table = mo.md("*(no data)*")
        synthesis_threshold = float("nan")
        highprec_threshold = float("nan")
        f1_threshold = float("nan")
        synthesis_recall = float("nan")
        highprec_recall = float("nan")
        f1_recall_val = float("nan")
        synthesis_precision = float("nan")
        highprec_precision = float("nan")
        f1_precision_val = float("nan")
    else:
        import numpy as np

        _precision = pr_curve_df["precision"].values
        _recall = pr_curve_df["recall"].values
        _thresholds = pr_curve_df["threshold"].values

        # Synthesis floor: most aggressive (highest) threshold where recall >= 0.80
        _synth_mask = _recall >= 0.80
        synthesis_threshold = (
            float(_thresholds[_synth_mask].max()) if _synth_mask.any() else float("nan")
        )
        synthesis_recall = (
            float(_recall[_synth_mask & (_thresholds == synthesis_threshold)][0])
            if _synth_mask.any()
            else float("nan")
        )
        synthesis_precision = (
            float(_precision[_synth_mask & (_thresholds == synthesis_threshold)][0])
            if _synth_mask.any()
            else float("nan")
        )

        # High-precision floor: highest precision where recall >= 0.50
        _hp_mask = _recall >= 0.50
        _hp_idx = _precision[_hp_mask].argmax() if _hp_mask.any() else None
        highprec_threshold = (
            float(_thresholds[_hp_mask][_hp_idx]) if _hp_mask.any() else float("nan")
        )
        highprec_recall = (
            float(_recall[_hp_mask][_hp_idx]) if _hp_mask.any() else float("nan")
        )
        highprec_precision = (
            float(_precision[_hp_mask][_hp_idx]) if _hp_mask.any() else float("nan")
        )

        # F1-optimal for reference
        _f1 = 2 * _precision * _recall / (_precision + _recall + 1e-9)
        _f1_idx = _f1.argmax()
        f1_threshold = float(_thresholds[_f1_idx])
        f1_recall_val = float(_recall[_f1_idx])
        f1_precision_val = float(_precision[_f1_idx])

        threshold_table = mo.md(f"""
        | Mode | Goal | Recommended floor | Recall | Precision |
        |------|------|:-----------------:|:------:|:---------:|
        | **Synthesis floor** | Exact recall ≥ 80% | `{synthesis_threshold:.2f}` | {synthesis_recall:.0%} | {synthesis_precision:.0%} |
        | **High-precision floor** | Max precision, recall ≥ 50% | `{highprec_threshold:.2f}` | {highprec_recall:.0%} | {highprec_precision:.0%} |
        | F1-optimal *(reference)* | Maximise F1 | `{f1_threshold:.2f}` | {f1_recall_val:.0%} | {f1_precision_val:.0%} |

        These are raw logit thresholds. To apply one, set `ANSWER_LOGIT_FLOOR` in the retrieval
        config and filter passages before synthesis.
        """)

    threshold_table
    return (
        f1_precision_val,
        f1_recall_val,
        f1_threshold,
        highprec_precision,
        highprec_recall,
        highprec_threshold,
        synthesis_precision,
        synthesis_recall,
        synthesis_threshold,
    )


@app.cell(hide_code=True)
def _(
    alt,
    available_files,
    f1_precision_val,
    f1_recall_val,
    f1_threshold,
    highprec_precision,
    highprec_recall,
    highprec_threshold,
    mo,
    pd,
    pr_auc,
    pr_curve_df,
    synthesis_precision,
    synthesis_recall,
    synthesis_threshold,
):
    if not available_files or pr_curve_df.empty:
        rec_chart = mo.md("*(no data)*")
    else:
        _line = (
            alt.Chart(pr_curve_df)
            .mark_line(color="#6366f1", strokeWidth=2)
            .encode(
                alt.X("recall:Q", scale=alt.Scale(domain=[0, 1]), title="Recall"),
                alt.Y("precision:Q", scale=alt.Scale(domain=[0, 1]), title="Precision"),
                tooltip=[
                    alt.Tooltip("threshold:Q", format=".2f", title="Threshold"),
                    alt.Tooltip("precision:Q", format=".3f"),
                    alt.Tooltip("recall:Q", format=".3f"),
                ],
            )
        )

        _domain = [
            f"Synthesis floor ({synthesis_threshold:.2f})",
            f"High-precision floor ({highprec_threshold:.2f})",
            f"F1-optimal ({f1_threshold:.2f})",
        ]

        _marker_data = pd.DataFrame(
            [
                {
                    "recall": synthesis_recall,
                    "precision": synthesis_precision,
                    "threshold": synthesis_threshold,
                    "label": _domain[0],
                },
                {
                    "recall": highprec_recall,
                    "precision": highprec_precision,
                    "threshold": highprec_threshold,
                    "label": _domain[1],
                },
                {
                    "recall": f1_recall_val,
                    "precision": f1_precision_val,
                    "threshold": f1_threshold,
                    "label": _domain[2],
                },
            ]
        )

        _markers = (
            alt.Chart(_marker_data)
            .mark_point(filled=True, size=120)
            .encode(
                alt.X("recall:Q"),
                alt.Y("precision:Q"),
                alt.Color(
                    "label:N",
                    scale=alt.Scale(
                        domain=_domain,
                        range=["#22c55e", "#f59e0b", "#ef4444"],
                    ),
                    legend=alt.Legend(title="Operating point"),
                ),
                tooltip=[
                    alt.Tooltip("label:N", title="Operating point"),
                    alt.Tooltip("threshold:Q", format=".2f", title="Threshold"),
                    alt.Tooltip("recall:Q", format=".3f"),
                    alt.Tooltip("precision:Q", format=".3f"),
                ],
            )
        )

        rec_chart = mo.hstack(
            [
                (_line + _markers).properties(
                    title=f"Precision-Recall with operating points  (AUC = {pr_auc:.3f})",
                    width=600,
                    height=350,
                )
            ],
            justify="center",
        )

    rec_chart
    return


if __name__ == "__main__":
    app.run()
