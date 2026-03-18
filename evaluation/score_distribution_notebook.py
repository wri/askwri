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
    # Score Distribution Analysis

    Explores raw cross-encoder logit scores and normalized scores for retrieved documents,
    split by whether each document is a known-relevant result from the golden set.

    **Run the data collection script first:**
    ```
    npx tsx --env-file-if-exists=.env evaluation/score-distribution-analysis.ts
    ```
    Then point the file picker below at the resulting `results/score-distribution-<timestamp>.json`.
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
        glob.glob(os.path.join(results_dir, "score-distribution-*.json"))
    )
    available_files
    return (available_files,)


@app.cell(hide_code=True)
def _(available_files, mo, os):
    file_picker = mo.ui.dropdown(
        options={os.path.basename(f): f for f in available_files},
        value=os.path.basename(available_files[-1]) if available_files else None,
        label="Score distribution file",
    )
    file_picker
    return (file_picker,)


@app.cell(hide_code=True)
def _(file_picker, json, pd):
    with open(file_picker.value) as f:
        raw = json.load(f)

    rows = []
    for query in raw["queries"]:
        for doc in query["docs"]:
            rows.append(
                {
                    "query_id": query["query_id"],
                    "question": query["question"],
                    "query_type": query["query_type"],
                    "difficulty": query["difficulty"],
                    "rank": doc["rank"],
                    "doc_id": doc["doc_id"],
                    "title": doc["title"],
                    "url": doc["url"],
                    "normalized_score": doc["normalized_score"],
                    "raw_logit": doc["raw_logit"],
                    "is_relevant": doc["is_relevant"],
                }
            )

    df = pd.DataFrame(rows)
    df["rank"] = df["rank"].astype(int)
    df["normalized_score"] = df["normalized_score"].astype(float)
    df["raw_logit"] = pd.to_numeric(df["raw_logit"], errors="coerce")
    df["is_relevant"] = df["is_relevant"].astype(bool)
    df["relevance"] = df["is_relevant"].map({True: "Relevant", False: "Not relevant"})

    print(
        f"Loaded {len(df)} rows — {df['query_id'].nunique()} queries, "
        f"{df['is_relevant'].sum()} relevant / {(~df['is_relevant']).sum()} not-relevant"
    )
    df.head()
    return df, raw


@app.cell(hide_code=True)
def _(mo, raw):
    s = raw["summary"]
    mo.md(f"""
    **Run metadata**
    Generated: `{raw["generated_at"]}`
    Service: `{raw["service_url"]}`
    Golden dataset: `{raw["golden_dataset"]}`
    Params: max\\_results={raw["params"]["max_results"]}, rerank\\_top\\_n={raw["params"]["rerank_top_n"]}

    | Queries | Docs retrieved | Relevant retrieved | Expected | Overall recall@{raw["params"]["max_results"]} |
    |---------|---------------|-------------------|----------|------|
    | {s["total_queries"]} | {s["total_docs_retrieved"]} | {s["total_relevant_retrieved"]} | {s["total_expected"]} | {s["overall_recall_at_max"]:.1%} |
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Raw logit distribution — relevant vs not-relevant
    """)
    return


@app.cell(hide_code=True)
def _(alt, df):
    COLOR_SCALE = alt.Scale(
        domain=["Relevant", "Not relevant"],
        range=["#22c55e", "#94a3b8"],
    )

    def hist_layers(
        data,
        field,
        maxbins=40,
        width=380,
        height=280,
        title="",
        x_scale=alt.Undefined,
    ):
        """Two overlaid bar layers — one per relevance group — for small samples where stack=None normalizes."""
        bin_def = alt.Bin(maxbins=maxbins)
        not_rel = (
            alt.Chart(data[data["relevance"] == "Not relevant"])
            .mark_bar(opacity=0.6, binSpacing=0, color="#94a3b8")
            .encode(
                alt.X(f"{field}:Q", bin=bin_def, title=field, scale=x_scale),
                alt.Y("count():Q", title="Count"),
                tooltip=[alt.Tooltip(f"{field}:Q", format=".2f"), "count():Q"],
            )
        )
        rel = (
            alt.Chart(data[data["relevance"] == "Relevant"])
            .mark_bar(opacity=0.6, binSpacing=0, color="#22c55e")
            .encode(
                alt.X(f"{field}:Q", bin=bin_def, title=field, scale=x_scale),
                alt.Y("count():Q", title="Count"),
                tooltip=[alt.Tooltip(f"{field}:Q", format=".2f"), "count():Q"],
            )
        )
        return alt.layer(not_rel, rel).properties(
            title=title, width=width, height=height
        )

    logit_base = alt.Chart(df.dropna(subset=["raw_logit"]))

    # Global histogram: large enough sample that stack=None works correctly
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
        logit_kde_layer("Relevant", "#22c55e"),
    ).properties(title="Raw logit KDE", width=380, height=280)

    (logit_hist | logit_kde).resolve_scale(y="independent")
    return (COLOR_SCALE,)


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Normalized score distribution — relevant vs not-relevant
    """)
    return


@app.cell(hide_code=True)
def _(COLOR_SCALE, alt, df):
    norm_base = alt.Chart(df.dropna(subset=["normalized_score"]))

    # Global histogram: large enough sample that stack=None works correctly
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
            .transform_density("normalized_score", as_=["normalized_score", "density"])
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
        norm_kde_layer("Relevant", "#22c55e"),
    ).properties(title="Normalized score KDE", width=380, height=280)

    (norm_hist | norm_kde).resolve_scale(y="independent")
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Per-query breakdown
    """)
    return


@app.cell(hide_code=True)
def _(df):
    per_query = (
        df.groupby(["query_id", "query_type", "difficulty", "is_relevant"])["raw_logit"]
        .agg(["count", "min", "median", "max"])
        .round(2)
        .reset_index()
    )
    per_query.columns = [
        "query_id",
        "query_type",
        "difficulty",
        "is_relevant",
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


@app.cell
def _(df):
    df.groupby("is_relevant")[["raw_logit", "normalized_score"]].describe().round(3)
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Per-query threshold explorer
    """)
    return


@app.cell(hide_code=True)
def _(df, mo):
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
def _(df, mo):
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
def _(COLOR_SCALE, alt, df, mo, query_picker, threshold_slider):
    threshold = threshold_slider.value
    query_id = query_picker.value
    query_df = df[df["query_id"] == query_id].dropna(subset=["raw_logit"])

    n_total = len(query_df)
    n_relevant = int(query_df["is_relevant"].sum())
    n_surviving = int((query_df["raw_logit"] >= threshold).sum())
    n_rel_surviving = int(
        (query_df["is_relevant"] & (query_df["raw_logit"] >= threshold)).sum()
    )
    recall = n_rel_surviving / n_relevant if n_relevant > 0 else 0.0
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

    chart = alt.vconcat(
        logit_hist_q + threshold_rule,
        norm_hist_q,
    )

    stats = mo.md(f"""
    | | Count |
    |---|---|
    | Total docs retrieved | {n_total} |
    | Relevant docs | {n_relevant} |
    | Surviving threshold | {n_surviving} |
    | Relevant surviving | {n_rel_surviving} |
    | **Recall** | **{recall:.0%}** |
    | **Precision** | **{precision:.0%}** |
    """)

    mo.vstack([chart])
    return stats, threshold


@app.cell(hide_code=True)
def _(COLOR_SCALE, alt, df, mo, threshold_slider):
    all_threshold = threshold_slider.value
    all_df = df.dropna(subset=["raw_logit"])

    all_n_total = len(all_df)
    all_n_relevant = int(all_df["is_relevant"].sum())
    all_n_surviving = int((all_df["raw_logit"] >= all_threshold).sum())
    all_n_rel_surviving = int(
        (all_df["is_relevant"] & (all_df["raw_logit"] >= all_threshold)).sum()
    )
    all_recall = all_n_rel_surviving / all_n_relevant if all_n_relevant > 0 else 0.0
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

    all_stats = mo.md(f"""
    | | Count |
    |---|---|
    | Total docs retrieved | {all_n_total} |
    | Relevant docs | {all_n_relevant} |
    | Surviving threshold | {all_n_surviving} |
    | Relevant surviving | {all_n_rel_surviving} |
    | **Recall** | **{all_recall:.0%}** |
    | **Precision** | **{all_precision:.0%}** |
    """)

    mo.vstack([all_hist + all_threshold_rule])
    return (all_stats,)


@app.cell(hide_code=True)
def _(all_stats, mo, query_picker, stats, threshold):
    mo.vstack(
        [
            mo.md(f"Applying the following value as threshold: **{threshold:.1f}**"),
            mo.hstack(
                [
                    mo.md(f"**For query '{query_picker.value}**'"),
                    mo.md(f"**For All queries**"),
                ],
                justify="center",
                widths="equal",
            ),
            mo.hstack(
                [
                    stats,
                    all_stats,
                ],
                justify="center",
            ),
        ]
    )
    return


@app.cell(hide_code=True)
def _(alt, mo, pr_auc, pr_curve_df, roc_auc, roc_curve_df, threshold_slider):
    _threshold = threshold_slider.value

    # Operating point on PR curve: row with threshold closest to selected value
    _pr_op_idx = (pr_curve_df["threshold"] - _threshold).abs().idxmin()
    _pr_op = pr_curve_df.loc[[_pr_op_idx], ["recall", "precision", "threshold"]]

    # Operating point on ROC curve
    _roc_op_idx = (roc_curve_df["threshold"] - _threshold).abs().idxmin()
    _roc_op = roc_curve_df.loc[[_roc_op_idx], ["fpr", "tpr", "threshold"]]

    # ---- PR curve ----
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
            f"Precision-Recall  (AUC = {pr_auc:.3f})",
            subtitle="Red dot = current threshold",
        ),
        width=340,
        height=300,
    )

    # ---- ROC curve ----
    roc_line = (
        alt.Chart(roc_curve_df)
        .mark_line(color="#6366f1", strokeWidth=2)
        .encode(
            alt.X(
                "fpr:Q",
                scale=alt.Scale(domain=[0, 1]),
                title="False positive rate",
            ),
            alt.Y("tpr:Q", scale=alt.Scale(domain=[0, 1]), title="True positive rate"),
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
            f"ROC  (AUC = {roc_auc:.3f})",
            subtitle="Red dot = current threshold",
        ),
        width=340,
        height=300,
    )

    mo.hstack([pr_chart, roc_chart], justify="center")
    return


@app.cell(hide_code=True)
def _(threshold_slider):
    threshold_slider
    return


@app.cell(hide_code=True)
def _(df, pd):
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
def _(mo):
    mo.md(r"""
    ## Threshold recommendations

    Sweeps the PR curve to suggest thresholds for `CITE_LOGIT_FLOOR` and `ANSWER_LOGIT_FLOOR`
    - **Cite floor** — most aggressive threshold that keeps recall ≥ 75%
    - **Answer floor** — highest-precision threshold that keeps recall ≥ 50%
    """)
    return


@app.cell(hide_code=True)
def _(mo, pr_curve_df):
    import numpy as np

    _precision = pr_curve_df["precision"].values
    _recall = pr_curve_df["recall"].values
    _thresholds = pr_curve_df["threshold"].values

    # Cite: most aggressive (highest) threshold where recall >= 0.75
    _cite_mask = _recall >= 0.75
    cite_threshold = (
        float(_thresholds[_cite_mask].max()) if _cite_mask.any() else float("nan")
    )
    cite_recall = (
        float(_recall[_cite_mask & (_thresholds == cite_threshold)][0])
        if _cite_mask.any()
        else float("nan")
    )
    cite_precision = (
        float(_precision[_cite_mask & (_thresholds == cite_threshold)][0])
        if _cite_mask.any()
        else float("nan")
    )

    # Answer: highest precision where recall >= 0.50
    _answer_mask = _recall >= 0.50
    _answer_prec_idx = _precision[_answer_mask].argmax() if _answer_mask.any() else None
    answer_threshold = (
        float(_thresholds[_answer_mask][_answer_prec_idx])
        if _answer_mask.any()
        else float("nan")
    )
    answer_recall = (
        float(_recall[_answer_mask][_answer_prec_idx])
        if _answer_mask.any()
        else float("nan")
    )
    answer_precision = (
        float(_precision[_answer_mask][_answer_prec_idx])
        if _answer_mask.any()
        else float("nan")
    )

    # F1-optimal for reference
    _f1 = 2 * _precision * _recall / (_precision + _recall + 1e-9)
    _f1_idx = _f1.argmax()
    f1_threshold = float(_thresholds[_f1_idx])
    f1_recall = float(_recall[_f1_idx])
    f1_precision = float(_precision[_f1_idx])

    mo.md(f"""
    | Mode | Goal | Recommended floor | Recall | Precision |
    |------|------|:-----------------:|:------:|:---------:|
    | **Cite** | Recall ≥ 75% | `{cite_threshold:.2f}` | {cite_recall:.0%} | {cite_precision:.0%} |
    | **Answer** | Max precision, recall ≥ 50% | `{answer_threshold:.2f}` | {answer_recall:.0%} | {answer_precision:.0%} |
    | F1-optimal *(reference)* | Maximise F1 | `{f1_threshold:.2f}` | {f1_recall:.0%} | {f1_precision:.0%} |

    These are raw logit thresholds to use as `CITE_LOGIT_FLOOR` and `ANSWER_LOGIT_FLOOR`
    """)
    return (
        answer_precision,
        answer_recall,
        answer_threshold,
        cite_precision,
        cite_recall,
        cite_threshold,
        f1_precision,
        f1_recall,
        f1_threshold,
    )


@app.cell(hide_code=True)
def _(
    alt,
    answer_precision,
    answer_recall,
    answer_threshold,
    cite_precision,
    cite_recall,
    cite_threshold,
    f1_precision,
    f1_recall,
    f1_threshold,
    mo,
    pd,
    pr_auc,
    pr_curve_df,
):
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
        f"Cite floor ({cite_threshold:.2f})",
        f"Answer floor ({answer_threshold:.2f})",
        f"F1-optimal ({f1_threshold:.2f})",
    ]

    _marker_data = pd.DataFrame(
        [
            {
                "recall": cite_recall,
                "precision": cite_precision,
                "threshold": cite_threshold,
                "label": _domain[0],
            },
            {
                "recall": answer_recall,
                "precision": answer_precision,
                "threshold": answer_threshold,
                "label": _domain[1],
            },
            {
                "recall": f1_recall,
                "precision": f1_precision,
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

    _chart = (_line + _markers).properties(
        title=f"Precision-Recall with operating points  (AUC = {pr_auc:.3f})",
        width=600,
        height=350,
    )

    mo.hstack([_chart], justify="center")
    return


if __name__ == "__main__":
    app.run()
