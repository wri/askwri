"""
Query expansion for transport decarbonization domain

Maps broad user queries to specific technical terminology used in the corpus.
Based on actual document vocabulary, not eval-specific tuning.

Design principles:
1. Domain-specific: Only expand terms relevant to transport/urban sustainability
2. Corpus-grounded: Synonyms must appear in actual documents
3. Conservative: Only expand when clear semantic equivalence exists
4. Cross-language: Include Spanish/Chinese equivalents for multilingual corpus
"""

# Core domain concept mappings
# Format: user_term -> [synonym1, synonym2, ...]
DOMAIN_EXPANSIONS = {
    # Finance & Economics
    "finance": [
        "financing",
        "funding",
        "investment",
        "financial mechanisms",
        "economic",
        "costs",
        "financieros",  # Spanish
        "investimento"  # Portuguese
    ],

    "urban finance": [
        "transit financing",
        "infrastructure funding",
        "urban investment",
        "municipal finance",
        "transport finance",
        "mobility financing"
    ],

    # Transportation modes
    "buses": [
        "bus",
        "transit",
        "public transport",
        "mass transit",
        "BRT",
        "bus rapid transit"
    ],

    "electric buses": [
        "e-buses",
        "electric transit",
        "battery buses",
        "zero-emission buses",
        "EV buses"
    ],

    "micromobility": [
        "bike sharing",
        "e-bikes",
        "electric bikes",
        "scooters",
        "bike-share",
        "bicycle sharing",
        "dockless",
        "shared mobility"
    ],

    # Alternative fuels
    "hydrogen": [
        "fuel cell",
        "H2",
        "hydrogen fuel",
        "fuel cells",
        "alternative fuels"
    ],

    # Environmental themes
    "climate": [
        "climate change",
        "emissions",
        "greenhouse gas",
        "GHG",
        "carbon",
        "decarbonization",
        "decarbonisation",
        "low-carbon"
    ],

    "pollution": [
        "air quality",
        "emissions",
        "air pollution",
        "particulate matter",
        "PM2.5",
        "NOx"
    ],

    # Urban planning
    "housing": [
        "affordable housing",
        "informal settlements",
        "residential",
        "housing crisis",
        "land use",
        "TOD",
        "transit-oriented development"
    ],

    "land value capture": [
        "LVC",
        "value capture",
        "betterment levy",
        "land value tax",
        "property tax"
    ],

    # Infrastructure
    "infrastructure": [
        "infrastructure",
        "built environment",
        "facilities",
        "systems",
        "networks"
    ],

    "charging": [
        "charging infrastructure",
        "charging stations",
        "EV charging",
        "chargers",
        "charging network"
    ],

    # Health & equity
    "health": [
        "public health",
        "health impacts",
        "health outcomes",
        "wellness",
        "safety"
    ],

    "children": [
        "kids",
        "students",
        "youth",
        "schools",
        "school buses"
    ],

    "equity": [
        "equitable",
        "inclusive",
        "accessibility",
        "social equity",
        "environmental justice"
    ],

    # Policy & governance
    "policy": [
        "policies",
        "regulation",
        "governance",
        "legislation",
        "mandates"
    ],

    "planning": [
        "urban planning",
        "city planning",
        "transport planning",
        "land use planning"
    ],

    # Nature & environment
    "nature": [
        "nature-based solutions",
        "NBS",
        "green infrastructure",
        "natural infrastructure",
        "green space",
        "parks"
    ],

    # Geographies (example cities - add more as needed)
    "bangalore": [
        "bengaluru",
        "bangalore",
        "india"
    ],

    "brazil": [
        "brazilian",
        "brasil",
        "são paulo",
        "rio"
    ]
}

# Stop words that should NOT be expanded (avoid over-matching)
STOP_WORDS = {
    "have", "published", "anything", "with", "what", "where", "when",
    "who", "how", "can", "will", "be", "do", "does", "did",
    "the", "a", "an", "and", "or", "but", "in", "on", "at",
    "to", "for", "of", "from", "by", "about", "since", "after"
}

def expand_query(query: str) -> str:
    """
    Expand user query with domain-specific synonyms for BM25 search.

    Args:
        query: Original user query

    Returns:
        Expanded query with OR-separated synonyms

    Example:
        "urban finance" -> "urban finance OR transit financing OR infrastructure funding OR municipal finance"
    """
    query_lower = query.lower()
    expanded_terms = []

    # Track what we've already added to avoid duplicates
    added_terms = set()
    added_terms.add(query_lower)
    expanded_terms.append(query)

    # Check for multi-word phrases first (longest match)
    phrases = sorted(DOMAIN_EXPANSIONS.keys(), key=len, reverse=True)

    for phrase in phrases:
        if phrase in query_lower and phrase not in STOP_WORDS:
            # Add synonyms for this phrase
            for synonym in DOMAIN_EXPANSIONS[phrase]:
                if synonym.lower() not in added_terms:
                    expanded_terms.append(synonym)
                    added_terms.add(synonym.lower())

    # If no expansions found, return original query
    if len(expanded_terms) == 1:
        return query

    # Join with OR for BM25 matching
    return " OR ".join(expanded_terms)

def expand_query_conservative(query: str, max_expansions: int = 3) -> str:
    """
    Conservative expansion - only add top N most relevant synonyms.

    Args:
        query: Original user query
        max_expansions: Maximum number of synonym groups to add

    Returns:
        Expanded query with limited synonyms
    """
    query_lower = query.lower()
    expanded_terms = [query]
    added_terms = {query_lower}
    expansion_count = 0

    # Check phrases (longest first)
    phrases = sorted(DOMAIN_EXPANSIONS.keys(), key=len, reverse=True)

    for phrase in phrases:
        if expansion_count >= max_expansions:
            break

        if phrase in query_lower and phrase not in STOP_WORDS:
            # Add top 2-3 most relevant synonyms only
            for synonym in DOMAIN_EXPANSIONS[phrase][:2]:
                if synonym.lower() not in added_terms:
                    expanded_terms.append(synonym)
                    added_terms.add(synonym.lower())
            expansion_count += 1

    if len(expanded_terms) == 1:
        return query

    return " OR ".join(expanded_terms)


# Test cases (for development verification)
if __name__ == "__main__":
    test_queries = [
        "What have we published on urban finance since 2020?",
        "Have we published any papers on hydrogen?",
        "How can cities implement micromobility solutions?",
        "What have we published on children and pollution?",
        "What can be done to solve the housing crisis in Jakarta?",
        "What have we published on Bangalore?"
    ]

    print("Query Expansion Test\n" + "="*80)
    for query in test_queries:
        expanded = expand_query(query)
        print(f"\nOriginal: {query}")
        print(f"Expanded: {expanded[:200]}..." if len(expanded) > 200 else f"Expanded: {expanded}")

    print("\n\nConservative Expansion Test\n" + "="*80)
    for query in test_queries:
        expanded = expand_query_conservative(query)
        print(f"\nOriginal: {query}")
        print(f"Expanded: {expanded[:200]}..." if len(expanded) > 200 else f"Expanded: {expanded}")
