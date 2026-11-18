# Route model sweep: routes-v1

- target: https://qa.askwri-app.org
- models: gpt-5.4-nano vs gpt-5.4-mini
- max_results: 40
- submodule commit: 1dcbeabc909073c4141e8088cce8b7fef6de243a
- evalset: evalset_answer_02.json
- evalset note: no expert_approved case in evalset_answer_02.json; the first 10 in file order were used
- code version: sha256:98a0835ef4e6fb890212f5f81bb7e8d408dbadd76662147f9f00201f7f469fab
- checks: 2 of 80 calls failed

No English control case: every case is non-English, so a regression that appears only on English input would not show here.

## Mechanical checks

Failed calls:
- batch-why / q5_bikeshare-trip-substitution / gpt-5.4-mini: response contains substituted text (provenance.sanitized), so part of it is not model output
- batch-why / q8_yantian-port-mode-shift-targets / gpt-5.4-nano: response was not produced by a model (fallback_reason: parse_error)

## Acceptance numbers

### batch-why
- gpt-5.4-nano — calls 10, failed 1, p95 9271 ms (n=10), cost $0.012863
- gpt-5.4-mini — calls 10, failed 1, p95 5231 ms (n=10), cost $0.038737
- cost of gpt-5.4-mini vs gpt-5.4-nano: +201.2%

### batch-relates
- gpt-5.4-nano — calls 10, failed 0, p95 5944 ms (n=10), cost $0.010095
- gpt-5.4-mini — calls 10, failed 0, p95 3643 ms (n=10), cost $0.033749
- cost of gpt-5.4-mini vs gpt-5.4-nano: +234.3%

### alignment
- gpt-5.4-nano — calls 10, failed 0, p95 3395 ms (n=10), cost $0.004527
- gpt-5.4-mini — calls 10, failed 0, p95 1791 ms (n=10), cost $0.015513
- cost of gpt-5.4-mini vs gpt-5.4-nano: +242.7%

### translate
- gpt-5.4-nano — calls 10, failed 0, p95 2951 ms (n=10), cost unmeasured
- gpt-5.4-mini — calls 10, failed 0, p95 1904 ms (n=10), cost unmeasured

## batch-why

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1825 ms)
1. This passage provides the report’s projected zero-emission heavy-duty truck (new energy heavy-duty trucks) penetration rate in China through 2030 in regional (RD) scenarios, including explicit percentage ranges. It directly answers part of the query about projected market penetration rates over the forecast period.
2. This passage is mainly definitional and does not state a penetration rate through 2035. It supports the methodology by defining metrics used in the penetration/impact analysis.
3. This passage discusses projections and strategies for decarbonizing China’s road transport sector, but it does not provide the specific projected market penetration rate for new energy heavy-duty trucks through 2035. It is relevant only as context for road transport decarbonization modeling.

**gpt-5.4-mini** (1737 ms)
1. This passage directly discusses projected penetration rates of zero-emission/new energy heavy-duty trucks in China through 2035. It explicitly gives a forecast for the regional delivery scenario by 2030, which is part of the requested 2035 outlook.
2. This passage only provides technical assumptions and abbreviations related to heavy-duty truck operating distances and truck types. It does not state any market penetration projections, so it is only indirectly related as background to the broader study.
3. This passage is about China’s road transport decarbonization strategies and mentions freight efficiency measures, which may be related to heavy-duty truck adoption. However, it does not explicitly provide the market penetration rate of new energy heavy-duty trucks through 2035, so it is only indirect context.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (7369 ms)
1. This passage is a techno-economic feasibility analysis specifically focused on zero-emission trucks in Guangdong, which typically includes cost elements relevant for comparing BEVs with diesel heavy-duty trucks in China.
2. This reference supports the China-specific vehicle data and cost-benefit evaluation context needed for estimating and comparing electric versus diesel vehicle economics, which underpins TCO comparisons.
3. This citation explicitly mentions a TCO comparison for heavy trucks in China across battery-electric and diesel trucks, which directly addresses the query about how total cost of ownership compares between BEVs and diesel heavy-duty trucks in China.
4. This passage is about policies and models for accelerating zero-emission heavy-duty trucks, and may provide assumptions or market/economic structure useful for TCO comparison, though it is not necessarily the cost comparison itself.
5. Like Passage 4, this focuses on market modeling and policy acceleration for zero-emission trucks, which can inform the economic inputs needed for TCO comparisons between electric and diesel trucks.
6. This discusses barriers affecting BEVs and fuel cell vehicles rather than presenting a direct TCO comparison between BEVs and diesel trucks, but it helps explain non-cost factors that can affect realized TCO.
7. This provides sectoral transition pathway analysis toward carbon neutrality, which may include relative costs of decarbonization options (implicitly electric vs diesel), but it is not directly a BEV-vs-diesel heavy-duty truck TCO comparison.
8. This is a port transportation systems study that may include logistics cost and energy tradeoffs, but it is not specifically about heavy-duty trucks TCO comparisons between BEVs and diesel in China.
9. This describes the vehicle fleet model (stocks, usage, emissions, energy use) for China; while not a direct TCO comparison, it provides underlying data needed for TCO modeling of electric vs diesel trucks.
10. This passage explicitly compares total cost of ownership of different heavy truck types and states that certain pure electric heavy trucks can reach TCO parity with traditional fuel trucks under a 1:1 replacement scenario, which directly relates to BEV vs diesel TCO in China.
11. This passage defines TCO and includes an explicit “Comparison” table reference for zero-emission freight scenarios, which should directly contain numeric comparisons of TCO between electric (e.g., BEV) and ICE/diesel heavy-duty trucks.
12. This passage is about net-zero road transport pathways and includes vehicle technology categories by duty class (including heavy duty). It helps contextualize which electric options exist, but it does not directly quantify TCO between BEVs and diesel heavy trucks.
13. This is a costs and benefits appraisal tool for transit buses comparing diesel and battery electrics; however, it is for buses rather than heavy-duty trucks, so it is only indirectly relevant to the general TCO methodology.
14. This discusses prior TCO findings showing electric vehicles (buses) can be cheaper than diesel counterparts, providing general support for TCO comparisons, though not specific to Chinese heavy-duty trucks.
15. This reviews studies about TCO of electric buses and battery degradation impacts; it is not heavy-duty trucks in China, but it is relevant for how battery degradation factors can affect TCO comparisons.
16. This is a methodology guide for transport emissions and social cost assessment, not a truck TCO comparison between BEVs and diesel; its relevance is limited to external cost methods rather than ownership cost.
17. This guidance report explains that electric buses can reduce cost of ownership and discusses operating cost outcomes, which may inform general expectations for TCO impacts, but it does not provide the requested China heavy-duty truck BEV vs diesel comparison.
18. This focuses on electrifying a US school bus fleet; it is not about Chinese heavy-duty trucks or a BEV-vs-diesel TCO comparison, so relevance is minimal and only methodological.
19. This tool is designed to compare zero-emission and diesel trucks (including comparative economic metrics like payback), which directly supports understanding how TCO-type financial performance differs between ZETs and ICE trucks.
20. This describes what TCO includes and provides a conceptual framework for TCO comparisons (purchase, operating, maintenance, etc.). It is not specific to heavy-duty trucks in China, but it helps interpret TCO components used in truck comparisons.

**gpt-5.4-mini** (4888 ms)
1. This passage is relevant because it explicitly cites a study on total cost of ownership for heavy trucks in China comparing battery-electric, fuel cell electric, and diesel trucks. It directly points to the exact comparison asked in the query, even though the excerpt itself does not give the results.
2. This passage is only indirectly relevant because it comes from a broader report on decarbonizing China's road transport sector and references electric vehicle cost studies. It may provide contextual background on truck electrification economics, but it does not directly compare battery electric and diesel heavy-duty truck TCO in China.
3. This passage is directly relevant because it explicitly references a study titled 'Total Cost of Ownership for Heavy Trucks in China: Battery-Electric, Fuel Cell Electric, and Diesel Trucks.' That study appears to be exactly about the cost comparison requested in the query.
4. This passage is only indirectly relevant because it is a bibliography entry from a report on zero-emission heavy-duty trucks in China. It may point to related market and policy modeling literature, but it does not itself compare TCO between battery electric and diesel trucks.
5. This passage is indirectly relevant for the same reason as Passage 4: it is part of a reference list and includes vehicle market modeling sources that could inform truck adoption economics. However, it does not explicitly address TCO comparison between battery electric and diesel heavy-duty trucks in China.
6. This passage is indirectly relevant because it discusses barriers to adopting BEVs and FCVs, which may include cost considerations. Still, it does not specifically provide a TCO comparison for heavy-duty trucks in China.
7. This passage is only indirectly relevant since it is a general citation within a report on China’s road transport decarbonization. It does not directly answer the truck TCO comparison question.
8. This passage is indirectly relevant because it concerns freight transport and port logistics in Shenzhen, which may include electrified trucking or cost evaluations. However, the excerpt does not explicitly compare battery electric and diesel heavy-duty truck ownership costs.
9. This passage is indirectly relevant because it is a technical reference for modeling vehicle stocks, emissions, and energy use in Guangdong, which can support TCO analyses. But it does not itself state a TCO comparison for heavy-duty trucks.
10. This passage is directly relevant because it states that some battery electric heavy-duty truck types can achieve TCO parity with diesel heavy trucks in an ideal 1:1 replacement scenario. It clearly addresses the ownership-cost comparison asked in the query and is about China specifically.
11. This passage is directly relevant in a supporting sense because it defines TCO and presents a comparison table for heavy-duty trucks. Even though the excerpt is only a caption and not the results, it is clearly tied to comparing costs between truck types in China.
12. This passage is only indirectly relevant because it includes a legend defining BEV and HD categories in a broader decarbonization report. It does not provide a specific TCO comparison for heavy-duty trucks in China.
13. This passage is indirectly relevant because it is about a comparative cost-benefit tool for transit buses, including China. It relates to electric-versus-diesel vehicle cost comparisons, but it is not about heavy-duty trucks.
14. This passage is only indirectly relevant because it summarizes prior TCO studies showing electric buses can be cheaper than diesel buses. It concerns electrified heavy vehicles in general, but not heavy-duty trucks in China.
15. This passage is indirectly relevant because it explains TCO analysis for e-buses and discusses battery degradation impacts. It provides methodological background that could apply to truck TCO studies, but it does not answer the truck-specific question.
16. This passage is only indirectly relevant because it is a methodology guide for transport emissions and social cost assessment, not a truck TCO comparison. It may offer analytical context but does not address battery electric versus diesel heavy-duty truck ownership costs.
17. This passage is indirectly relevant because it says electric buses can be beneficial through reduced ownership costs, which is conceptually similar to the query. However, it does not concern heavy-duty trucks in China or provide a truck TCO comparison.
18. This passage is only indirectly relevant because it is about electrifying school buses in the United States, not heavy-duty trucks in China. It may discuss policy impacts on adoption, but not the requested TCO comparison.
19. This passage is directly relevant in a contextual way because it is a comparative feasibility tool for zero-emission versus diesel trucks. Although it focuses on India rather than China, it is closely related to the type of TCO comparison asked in the query.
20. This passage is only indirectly relevant because it is a guidebook on auto-rickshaw electrification and TCO, not heavy-duty trucks. It may provide general TCO framing but does not address the query’s vehicle class or country.

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (4774 ms)
1. This passage directly compares zero-emission truck (ZET) adoption outcomes in regional delivery versus other contexts, stating that without policy incentives regional delivery reaches only a modest ZET market share by MY2030. It provides the key quantitative framing needed to contrast regional transport adoption potential against long-haul scenarios.
2. While not comparing modes explicitly, this passage discusses a key sensitivity assumption (Residual_value_30%) used in the analysis. Such sensitivity inputs affect modeled adoption potential across scenarios that include both regional transport and long-haul transport, enabling a fair comparison of adoption potential differences.
3. This passage explains why heavy-duty truck adoption can be delayed due to technology constraints, late TCO parity, and lack of policy incentives. These factors underpin the scenario differences in adoption potential between regional transport and long-haul transport by clarifying why adoption may be weaker in certain freight segments.
4. This passage is about road transport emissions by mode under different policy scenarios, which is related background for understanding adoption potential implications. However, it does not specifically quantify or directly compare zero-emission truck adoption potential between regional and long-haul transport.
5. This passage directly addresses how the implementation of zero-emission freight zones (ZEFZs) within logistic-center locations would affect long-haul/ regional-haul transportation and goods supply. It is directly relevant because it links a policy mechanism to differences in regional versus long-haul transport impacts that can translate into adoption potential.
6. This passage provides evidence that BEVs work well for most urban light delivery but face challenges in long-distance and cold-chain contexts. This supports the broader distinction between shorter-regional use and long-haul adoption potential, even though it is framed around urban applications.
7. This passage is only about methodology and sourcing (personal communications) and does not discuss adoption potential differences between regional and long-haul transport. It contributes no substantive content to the modal comparison requested.
8. Like Passage 7, this is documentation of sources (personal communications) rather than an analysis of adoption potential across transport types. It is therefore not directly informative for the regional vs long-haul adoption potential difference.
9. This passage discusses limitations of a financial impact assessment tool and sensitivity to financial assumptions (interest rates, inflation, fuel cost). While it can affect adoption potential estimates that might be applied to both regional and long-haul scenarios, it does not itself state the difference between those scenarios.

**gpt-5.4-mini** (2407 ms)
1. This passage directly addresses regional delivery adoption potential by stating a projected ZET market share range for regional delivery, which is one half of the comparison asked in the query.
2. This passage is about sensitivity assumptions for residual value and truck pricing, which may influence adoption modeling, but it does not compare regional transport with long-haul transport adoption potential.
3. This passage gives broader background on heavy-duty truck decarbonization barriers and policy context, which can help explain why adoption potential differs across scenarios, but it does not provide the specific regional versus long-haul comparison.
4. This passage concerns transport emissions scenarios in Guangdong and is related to road transport decarbonization planning, but it does not specifically discuss zero-emission truck adoption potential in regional versus long-haul transport.
5. This passage explicitly mentions both long-haul and regional-haul transportation as affected categories, making it relevant context for comparing the two freight segments in the query.
6. This passage contrasts urban light-duty delivery with longer-distance and cold-chain applications, which is relevant background for understanding why long-haul adoption may differ from regional transport, but it does not directly answer the query.
7. This is a references or methods-style passage about data sources and expert communication, not substantive results on adoption potential, so it is only minimally related.
8. This is another citation/data-source passage without results or comparison content about regional versus long-haul adoption potential, so it is only indirectly relevant at best.
9. This passage discusses a financial feasibility tool and its limitations, which may be relevant to assessing adoption potential generally, but it does not compare regional transport and long-haul scenarios.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (5308 ms)
1. This passage provides assumptions about diesel truck residual value and discusses sensitivity around zero-emission truck residuals, both of which affect comparative cash flows. Those assumptions are key inputs to calculating payback periods relative to diesel.
2. This study focuses on techno-economic feasibility of zero-emission trucks (including battery electric trucks) in Chinese use cases such as ports and delivery. While it may not directly report payback periods in the excerpt, it is directly relevant because payback period depends on the techno-economic cost and cash-flow comparison between BEVs and diesel.
3. This passage states a specific residual-value guarantee assumption (30% of retail price) used for sensitivity analysis for ZETs. Residual value is a major determinant of total cost of ownership and therefore the payback period compared with diesel.
4. It reports that battery electric trucks achieve TCO parity with ICEV (diesel) counterparts before MY2027 in certain use cases. TCO parity timing is closely related to payback period (when cumulative savings break even), so this is directly informative for payback comparisons.
5. This passage defines what payback period means and frames it as an output metric from a comparative financial feasibility tool. It is relevant because it explains how payback periods are calculated/interpreted when comparing zero-emission and internal combustion trucks.
6. This reference supports background context on vehicle statistics and cost/benefit evaluation for electric vehicles in China during 2020–2035. Such data can be used to parameterize models that estimate payback periods, even though the excerpt does not provide payback numbers itself.
7. This citation indicates the existence of a white paper specifically about TCO for heavy trucks in China across battery electric, fuel cell, and diesel. Since payback period is derived from the financial comparison between BEVs and diesel, this is highly relevant.
8. This passage provides quantified cost differences between pure electric trucks and conventional fuel trucks and discusses TCO parity/vehicle mileage thresholds (e.g., where parity may occur). Those thresholds can be used to infer or approximate payback timing versus diesel, making it directly relevant.
9. This discusses the economic implications of battery-electric heavy trucks versus other segments and explains market structure (e.g., focus on lighter trucks). While not directly giving payback periods, it provides context on why economic outcomes differ, which is important for interpreting payback versus diesel in China.
10. This reference to a China vehicle fleet model supports inputs like vehicle stocks, usage, emissions, and energy use—parameters that feed financial models estimating BEV-vs-diesel economics. Those modeling inputs indirectly affect computed payback periods.
11. This citation points to a white paper on total cost of ownership for heavy trucks in China comparing battery electric, fuel cell, and diesel. TCO comparisons are core to estimating payback periods, so it is relevant to the query’s BEV vs diesel comparison.
12. This case study highlights the reliance on diesel trucks in China's container port transport systems. While it may not present payback periods in the excerpt, it provides diesel baseline context needed for comparing payback of battery electric alternatives.
13. This passage states that BEVs/H2 options accelerate uptake once they reach TCO parity with diesel, implying a timeline for when economic break-even occurs. Since payback period is the time to break even, the TCO-parity-to-uptake link makes this directly relevant to payback comparisons.

**gpt-5.4-mini** (3050 ms)
1. This passage is relevant because it discusses diesel truck residual value assumptions in a zero-emission truck cost analysis for China, which is part of the broader economic comparison needed to estimate payback periods versus diesel trucks.
2. This passage is only broadly related: it concerns battery electric trucks in Guangdong province, China, but the snippet does not mention payback periods or a diesel comparison, so it provides contextual background rather than the requested metric.
3. This passage is relevant because it is from a China heavy-duty truck cost study and references residual value assumptions used in total-cost comparisons. Such assumptions affect payback calculations when comparing battery electric trucks with diesel trucks.
4. This passage is directly relevant because it states that battery electric trucks reach TCO parity relative to internal combustion engine counterparts and gives a timeline, which is closely related to payback period comparisons with diesel trucks in China.
5. This passage is directly relevant because it defines payback period as the time needed for an investment to break even, which is the key concept behind the user’s question.
6. This passage is only indirectly relevant because it cites studies on electric vehicle costs in China, but it does not provide payback periods or a direct diesel-versus-battery-electric truck comparison.
7. This passage is indirectly relevant because it cites a white paper specifically about total cost of ownership for heavy trucks in China, including battery electric and diesel trucks. It likely contains the kind of payback-period comparison the query asks about, but the snippet itself does not state the numbers.
8. This passage is directly relevant because it gives cost differences between battery electric trucks and conventional fuel trucks and includes mileage thresholds for cost parity, which are closely related to payback period estimates.
9. This passage is only indirectly relevant because it discusses electric heavy trucks in China and their market development, but it does not provide payback period figures or a direct comparison with diesel trucks.
10. This passage is not clearly relevant to the specific question because it appears to be a citation/reference entry for a vehicle fleet model rather than a discussion of payback periods or truck TCO.
11. This passage is directly relevant because it cites the exact white paper on total cost of ownership for heavy trucks in China, including battery electric, fuel cell, and diesel trucks, which is likely a source for payback period comparisons.
12. This passage is indirectly relevant because it describes diesel trucks dominating China’s container port transport system, providing context for why battery electric truck payback comparisons matter, but it does not address payback periods directly.
13. This passage is directly relevant because it states that battery electric or hydrogen heavy goods vehicles may reach TCO parity with diesel, which is closely connected to payback period comparisons in the China context.

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-5.4-nano · ✗ gpt-5.4-mini — response contains substituted text (provenance.sanitized), so part of it is not model output

**gpt-5.4-nano** (9271 ms)
1. This WRI China passage reports survey findings on dockless bike-sharing trip purposes and explicitly quantifies how much cycling replaces other motorized trip types. It includes a figure range for substitution of short trips previously made by private cars, taxis, or ride-hailing.
2. This source discusses decarbonization strategies and includes methodology for estimating passenger-mode emissions, but it does not provide a China-specific share of bike-share trips that replace private car/taxi/ride-hailing. It is relevant only as background on transport mode accounting.
3. This excerpt explicitly states the survey-based substitution impacts of dockless bike-sharing, including the proportion of trips that replaced private-vehicle and ride-hailing-type travel. That directly targets the query about what share replaces private car/taxi/ride-hailing trips.
4. This passage provides unrelated mode-share targets for commute trips in other cities/countries and does not address China or the specific replacement of private car/taxi/ride-hailing by bike-share. It offers comparative context only.
5. This describes the scale of bicycle sharing systems in China (e.g., Hangzhou) but does not quantify modal substitution shares versus private cars/taxis/ride-hailing. Therefore it cannot answer the query directly.
6. This explains the emergence and growth of dockless bike sharing in China, but it does not include survey results on how many bike-share trips replace private car/taxi/ride-hailing trips. It provides historical context only.
7. This passage focuses on urban rail and bus trip volumes and China’s net-zero transport vision, not on bike-share modal substitution. It is not about replacement of private car/taxi/ride-hailing.
8. This is a table about another location’s access indicators and contains no information about bike-share replacing private car/taxi/ride-hailing trips in China. It is unrelated to the query.
9. This discusses ride-hailing electrification and emphasizes the importance of replacement vs. added travel, but it is focused on the United States/Europe/Canada rather than China and bike-share. It does not provide the requested China bike-share replacement share.
10. This covers emissions pathways for Hong Kong’s road transport, not bike-share substitution rates or China-wide replacement of car/taxi/ride-hailing trips. It is tangential at best.
11. This document addresses safe access to public transportation in China and includes data on walking proportions for slow-transport modes connecting to transit. It does not quantify the share of bike-share trips that replace private car/taxi/ride-hailing.
12. This methodology guide concerns emissions/social cost assessment and does not report any modal substitution share for bike-sharing in China. It is relevant only to the general topic of transport impacts, not the specific query.
13. This passage discusses ride-hailing substituting other modes in general terms, but it is about ride-hailing competition and not about bike-share in China replacing private car/taxi/ride-hailing trips. It does not answer the query.
14. This passage is about public bicycle sharing implementation lessons in India, not China and not about quantified replacement of car/taxi/ride-hailing trips. It is not directly relevant to the query.
15. This guide explains how cities should assess net GHG impacts of shared micromobility, including whether trips are additional or replaced. It does not provide China-specific empirical shares for replacement of private car/taxi/ride-hailing by bike-share.
16. This discusses the concept that replacement vs. additional trips affects environmental impact, but it does not provide the numeric China-specific share of bike-share trips replacing private car/taxi/ride-hailing. It’s only conceptual.
17. This passage gives a global overview of shared mobility growth and startups, but it does not provide China-specific data on modal replacement shares. It cannot answer the query directly.
18. This is a location-specific profile (Surabaya) with access-to-utilities indicators and no bike-share substitution data, particularly not for China. It is unrelated.
19. This describes ride-hailing service models in emerging cities and does not quantify bike-share replacement of private car/taxi/ride-hailing trips in China. It is not aligned to the bike-share substitution share asked.
20. This models grid impacts from EV adoption in China and mentions electric taxis, not bike-share trip substitution of private car/taxi/ride-hailing. It does not answer the bike-share replacement share question.
21. This table concerns informal/semiformal public transportation services in Latin America and includes motorcycle-taxi/bike-taxi metrics, not Chinese bike-share replacing car/taxi/ride-hailing trips. It is irrelevant to the query.
22. This provides data on the popularity and coverage of bike-sharing in China and broader vehicle ownership trends, but it does not quantify the share of bike-share trips that replace private car/taxi/ride-hailing. It is context only.
23. This Guadalajara table lists trip shares by mode (bus, taxi, private car, bicycle, etc.), but it is for a different city and not about bike-share substituting private car/taxi/ride-hailing in China. It does not answer the query.
24. This passage discusses mode choice for commuting in Bengaluru and other general behavioral model findings, not China and not bike-share substitution of private car/taxi/ride-hailing trips. It is not directly relevant.
25. This is about modeling costs for trips by private cars and chauffeur-driven cars in India (bus aggregators context). It does not include China bike-share replacement shares.
26. This proposes interventions to encourage fewer/shorter vehicle trips and more public transport/cycling, but it does not provide the specific empirical share of China bike-share trips replacing private car/taxi/ride-hailing. It’s policy background rather than the requested metric.

**gpt-5.4-mini** (5231 ms) — sanitized: some text was substituted
1. This passage directly discusses survey results on Chinese dockless bike-sharing and states that 17% to 45% of trips replaced private motorized travel, which is the core of the query about replacement of private car, taxi, or ride-hailing trips in China.
2. This passage is about transport emissions and passenger modes in China, but it does not mention bike-share substitution or replacement shares. It provides general context on transport-sector analysis rather than the specific question.
3. This passage directly states that 17% to 45% of bike-share trips replaced private motorized trips, and the excerpt explicitly notes substitution of private travel in Chinese cities. It is highly relevant to the query about what share of bike-share trips replace car/taxi/ride-hailing trips in China.
4. This passage is about electric mobility roadmaps and includes broad mode-share targets for walking and cycling, but it does not address bike-share trip replacement of private car, taxi, or ride-hailing trips in China. It is only tangentially related.
5. This passage gives general information about the size of China’s bike-share systems, not whether bike-share trips replace private car, taxi, or ride-hailing trips. It provides background only.
6. This passage describes the growth of dockless bike sharing in China, which is relevant context for the topic, but it does not provide replacement shares for trips. It is related background, not a direct answer.
7. This passage is about urban rail and bus usage in China and broader urban transport planning. It does not discuss bike-share trip substitution, so it is only indirectly related.
8. This passage appears to discuss transportation access and trip patterns, but the excerpt is truncated and does not clearly address bike-share substitution. It may be loosely relevant as transport context, but not directly.
9. This passage discusses ride-hailing’s role in replacing other vehicle miles, which is conceptually related to the query’s mention of ride-hailing trips. However, it does not provide China-specific bike-share replacement shares, so it is indirect.
10. This passage is about Hong Kong road emissions and does not mention bike-share replacement of private car, taxi, or ride-hailing trips in China. It is not directly relevant.
11. This passage emphasizes bike as a last-mile mode and improving safety for bicycle access to public transport in China. It provides context on cycling and transit connection, but not the substitution share asked in the query.
12. This methodology guide classifies transport modes including private car, but it does not discuss bike-share replacement behavior or China-specific shares. It is only background.
13. This passage is about ride-hailing as a mode substitute and thus relates to the idea of replacement, but it is not about bike-share trips or China-specific shares. It is indirectly relevant.
14. This passage discusses public bicycle sharing in India, not China, and does not answer the query about Chinese bike-share substitution shares. It is not directly relevant.
15. This guide on micromobility environmental impact may discuss trip replacement in general, but the excerpt does not provide the specific share replacing private car, taxi, or ride-hailing trips in China. It is indirect background.
16. This passage explicitly states that if shared trips replace other modes, environmental impacts change, which is related to substitution analysis. However, it does not quantify bike-share replacement shares in China, so it is indirect.
17. This passage is about shared mobility generally and mentions bike sharing as part of the sector, but it does not address replacement shares of bike-share trips in China. It provides broader context only.
18. This passage is about informal transport services in Latin America and not about Chinese bike-share substitution. It is unrelated to the query’s main topic.
19. This passage discusses ride-hailing market structure and platform models, which is only tangentially related to the query’s mention of ride-hailing trips. It does not answer the question about bike-share replacement shares.
20. This passage is about electric taxis in China and does not mention bike-share trips or replacement shares. It is not directly relevant to the query.
21. This passage is about transport categories in Guadalajara and includes private car and bicycle shares, but it is not about China or bike-share replacement of motorized trips. It is only indirectly related.
22. This passage discusses commuting mode choices in Bengaluru, including cars and two-wheelers, but not bike-sharing or China. It is not directly relevant.
23. This passage is about bus aggregators and car trip costs in India’s NCR, not bike-share substitution in China. It is only indirectly related.
24. This passage discusses transport strategies that encourage cycling and public transport, which is related to bike use generally, but it does not quantify how many bike-share trips replace private car, taxi, or ride-hailing trips in China. It is indirect context.
25. This passage provides relevant context for the query.
26. This passage provides relevant context for the query.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (5575 ms)
1. This passage is directly about dockless bike-sharing in Chinese cities and indicates that the study includes an emissions reduction estimate (along with health and safety). However, the provided excerpt does not show the specific CO2 reduction quantity attributable to bike-sharing.
2. It explicitly states that the analysis includes CO2 emissions estimation as part of evaluating dockless bike-sharing benefits in Chinese cities. The excerpt still cuts off before any numeric CO2 reduction value is provided.
3. This is about decarbonizing China’s road transport sector and carbon neutrality strategies, but it does not mention bike-sharing or attribute any CO2 reduction to it. It may be relevant background for emissions accounting context, not the specific bike-sharing figure.
4. This passage describes the scale and features of bike-sharing programs (including in China) but does not provide any CO2 emissions reduction estimate. It helps with understanding context and adoption, not the magnitude of reductions.
5. It provides specific numbers on the bicycle share system in Hangzhou, China, but does not quantify CO2 emissions reduction from bike-sharing. It is relevant for program scale rather than emissions impact.
6. This provides high-level modeling results about climate mitigation potential by country/region, without linking the reduction to bike-sharing in China. Therefore it does not answer the question about bike-sharing-attributed CO2 reductions.
7. This discusses transport CO2 emissions trends and emissions accounting credibility in Chinese cities. It does not mention bike-sharing or provide an attribution of CO2 reduction to bike-sharing.
8. This passage focuses on technology and operational aspects of bike sharing (e.g., integrated smart card payments) and does not include CO2 reduction estimates. It is not directly relevant to the question’s quantitative CO2 attribution.
9. This passage references shares of emissions by sector and includes pollutants, but it does not address bike-sharing or CO2 reduction attributed to bike-sharing. It is not responsive to the query.
10. This is about future transport emissions trajectories in China and scenarios to meet climate goals, without discussing bike-sharing or quantifying its CO2 contribution. It does not provide the bike-sharing-attributed CO2 reduction asked for.
11. This guide is about assessing environmental impacts of shared micromobility services, including emissions accounting approaches. While it may inform how CO2 reductions are calculated, it does not provide a China-specific quantified CO2 reduction from bike-sharing.
12. This excerpt is about scenario optimization in transport decarbonization and does not mention bike-sharing or CO2 reductions from bike-sharing in China. It is not relevant to the query’s specific attribution.
13. This passage explains how CO2 emissions are calculated for bicycle sharing by comparing alternative trips (e.g., assumed car trips). However, it is about India and does not provide the amount of CO2 reduction attributed to bike-sharing in China.
14. This discusses national energy and emissions structure and energy-related CO2 plateauing, not bike-sharing. It provides broader CO2 context for China but no quantification of bike-sharing-attributed reductions.
15. This is about feasibility analysis for zero-emission trucks in Guangdong and does not mention bike-sharing or CO2 reductions from bicycle sharing. It is unrelated to the query.

**gpt-5.4-mini** (3808 ms)
1. This passage directly discusses dockless bike sharing in Chinese cities and mentions a study with health and emissions benefits, so it is likely the source of the CO2 reduction figure asked about. However, the visible excerpt does not include the exact emissions reduction number.
2. This passage is directly relevant because it states that dockless bike sharing in China brings emission-reduction benefits and summarizes findings from the same report. It still does not show the exact CO2 reduction amount in the excerpt, but it clearly points to the relevant estimate.
3. This passage is about broader decarbonization of China's road transport sector and not specifically bike-sharing. It may provide background on transport emissions in China, but it does not address the bike-sharing CO2 reduction question directly.
4. This passage provides context about the scale of bike-sharing in China, especially in cities like Hangzhou, which helps frame the topic. It does not give any CO2 reduction estimate, so it is only indirectly relevant.
5. This is a general description of China's large bike-sharing systems and is useful background on the prevalence of bike sharing. It does not mention emissions reductions, so it is only indirectly relevant.
6. This passage concerns national emissions-reduction modeling for emerging economies, including China, but not bike-sharing specifically. It is only indirectly related as general climate-policy context.
7. This passage discusses transport CO2 emissions trends in Chinese cities, which provides background for why low-carbon mobility options matter. It does not mention bike-sharing or its emissions impact, so it is indirect.
8. This passage mentions integration of bike sharing with public transport in Chinese cities, showing how bike sharing functions in urban mobility systems. It does not quantify CO2 reductions, so it is indirectly relevant.
9. This passage gives transport-emissions shares for Beijing and is relevant only as broader emissions context in China. It does not discuss bike-sharing or the specific reduction amount asked about.
10. This passage is about China’s transport emissions trajectory and mitigation pathways, not bike-sharing. It provides background on the sector but does not answer the query directly.
11. This passage explains emissions accounting methods for shared micromobility services, which is methodologically relevant to estimating bike-sharing emissions impacts. It does not provide the specific CO2 reduction figure itself.
12. This passage is about transport decarbonization strategies in India and is unrelated to bike-sharing in China. It has no direct relevance to the query.
13. This passage is relevant because it explicitly states that CO2 emissions for public bicycle sharing are calculated and gives the assumption used for estimating reductions. It is about bike-sharing emissions, though in India rather than China, so it is only indirectly relevant to the China-specific query.
14. This passage discusses China’s overall energy-related CO2 emissions and national decarbonization context. It does not address bike-sharing or its emissions reduction, so it is only indirectly relevant.
15. This passage is about zero-emission trucks in China and not about bike-sharing. It does not contribute to the bike-sharing CO2 reduction question, so it is only indirectly relevant.

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (6114 ms)
1. This passage frames dockless bike-sharing as a popular transport system that significantly affects people’s lives, providing the study’s motivating context. That sets up an expectation that it discusses changes in mobility and travel behavior in Chinese cities.
2. This passage is the title/front matter of the report specifically about how dockless bike-sharing changes lives in Chinese cities. It directly signals that the source is intended to analyze impacts on urban travel behavior.
3. This passage provides background on the emergence and rapid growth of dockless bike-sharing in Chinese cities starting in 2015. That context is important for understanding the behavioral and mode-shift effects the query asks about.
4. This passage gives concrete information on the scale of bicycle-sharing systems in China (e.g., Hangzhou), which influences how widely it can alter travel patterns. Scale is a key prerequisite for assessing effects on travel behavior.
5. This passage compares bicycle-sharing penetration and infrastructure (stations and vehicles) and notes that China has the world’s largest bike-sharing systems. This supports interpreting how extensive availability may affect users’ travel behavior in Chinese cities.
6. This passage discusses decarbonization strategies and how emissions calculations are done, focusing on road transport impacts rather than user travel behavior. It may relate only indirectly to how mode changes from dockless biking could affect emissions.
7. This passage lists references related to shared bikes and urban planning guidance in China (e.g., MoBike and a white paper). While it doesn’t describe travel behavior effects directly, it points to sources likely discussing impacts on mobility patterns.
8. This passage indicates that shared bike services have expanded to 360+ cities while car ownership continues to rise, providing a context for potential substitution or competition among modes. Such mode-share dynamics are central to travel behavior effects.
9. This methodology guide focuses on emissions/social cost assessment for transport modes, not on how dockless bike-sharing changes trip choices or behavior. It is relevant only at a very indirect, analytical level if mode shifts are studied through costs.
10. This guide is about assessing the environmental impact of shared micromobility, including lifecycle analysis considerations. While not directly about behavior, it provides a framework that cities use to evaluate impacts that often stem from changes in how people travel.
11. This passage cites external sources about emissions and EVs and is not focused on dockless bike-sharing or Chinese travel behavior. It is only indirectly related to broader transport decarbonization contexts.
12. This passage discusses shared mobility impacts such as first-mile/last-mile patterns, which are directly tied to travel behavior changes. Even though it’s broader than dockless bikes, it supports the types of behavioral effects (trip chaining/access) the query is about.
13. This passage addresses demand and characteristics of shared mobility schemes, including ride-hailing, offering conceptual context for how new mobility affects travel patterns. It does not specifically cover dockless bikes in Chinese cities but relates to the behavioral mechanisms.
14. This passage explains that dockless technology reduces the need for parking infrastructure and relies on dockless operations. Changes in station/parking constraints can strongly influence how people choose routes, times, and modes.
15. This passage emphasizes the importance of considering existing mode shares to encourage sustainable mobility, which is a core driver of changes in travel behavior when new services like bike-sharing enter. It directly relates to how dockless bike-sharing may shift trips across modes.
16. This passage focuses on cycling needs and safety-oriented infrastructure design during and after COVID-19. While not specifically about travel behavior change from dockless bike-sharing, it addresses conditions that can affect cycling uptake and trip choices.
17. This passage is about assessing local climate policy coverage and mentions smart transportation concepts and time-based traffic regulation. It’s not about dockless bike-sharing behavior effects, but it provides policy context for how urban transport can be managed.

**gpt-5.4-mini** (3171 ms)
1. This passage identifies dockless bike-sharing as the subject and introduces it as a major shared transport system, making it relevant background for understanding its effects on travel behavior.
2. This is the report title in Chinese and English, directly indicating that the document analyzes how dockless bike-sharing changes urban life and mobility in Chinese cities.
3. This passage gives historical context on the rise of dockless bike-sharing in China, which is relevant for understanding the setting in which travel behavior changes occurred.
4. This passage discusses bicycle share systems in Chinese cities, including scale and prevalence, which provides context for urban travel patterns but does not directly address behavior change from dockless systems.
5. This passage states that China has the world’s largest bike-sharing systems, which is useful background for evaluating their potential influence on travel behavior in Chinese cities.
6. This passage is about transport-sector emissions methodology and does not address bike-sharing or travel behavior, so it is only minimally related if at all.
7. This passage is a citation list referencing a shared-bike white paper, so it only indirectly relates to the topic through source material on shared bikes in cities.
8. This passage mentions the growing popularity of shared bikes in many Chinese cities, which provides context for urban mobility trends related to travel behavior.
9. This passage concerns trucking and road-transport modeling, not bike-sharing or urban travel behavior, so it is not directly relevant.
10. This guide concerns shared micromobility environmental assessment, which is related to shared bikes but does not specifically explain how dockless bike-sharing affects travel behavior in Chinese cities.
11. This passage is about electric mobility roadmaps and emissions data, which are not directly about dockless bike-sharing or travel behavior.
12. This passage mentions first-mile and last-mile transportation patterns, which is relevant because dockless bike-sharing often affects access to transit and short-trip behavior.
13. This passage discusses shared mobility and ride-hailing growth, offering broader context on new mobility services but not specifically dockless bike-sharing in China.
14. This passage explicitly describes dockless public bicycle sharing and its ability to reduce parking infrastructure needs, which is relevant to how such systems can change travel behavior and access in cities.
15. This passage is about integrating mode shares into sustainable mobility planning, which provides general context for analyzing how bike-sharing may influence travel choices.
16. This passage focuses on safe bicycle infrastructure during COVID-19, which is related to cycling behavior but not specifically to dockless bike-sharing in Chinese cities.
17. This passage concerns climate policy and smart transportation systems, which is only tangentially related to bike-sharing and travel behavior.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✗ gpt-5.4-nano — response was not produced by a model (fallback_reason: parse_error) · ✓ gpt-5.4-mini

**gpt-5.4-nano** (3343 ms) — NOT EVIDENCE: the route answered with substituted text, not a model output (fallback_reason: parse_error)
1. This passage provides relevant context for the query.
2. This passage provides relevant context for the query.
3. This passage provides relevant context for the query.
4. This passage provides relevant context for the query.
5. This passage provides relevant context for the query.
6. This passage provides relevant context for the query.

**gpt-5.4-mini** (2824 ms)
1. This passage defines the emissions scope for Yantian Port transportation and distribution, which is relevant background for evaluating whether the port can meet mode-shift targets. However, it does not mention the Shenzhen Master Plan targets or compare policy ambition levels directly.
2. This passage discusses how different decarbonization measures have different impacts by region, which helps frame whether a simple policy trajectory may be enough. It does not specifically address Yantian Port or Shenzhen's mode-shift targets, so it is supporting context rather than a direct answer.
3. This passage explicitly explains what a 'Stated Policy' scenario is, which is central to the query's contrast between a stated-policy trajectory and more aggressive measures. It helps assess whether the queried targets would be achievable under that baseline policy pathway.
4. This passage notes that high-density Chinese cities may reverse mode shift toward private cars, implying that passive trends may work against mode-shift goals. It is relevant as contextual evidence that meeting such targets may require stronger intervention than a stated-policy path.
5. This passage describes concrete transport mode-shift policies, such as promoting public transit and reducing car dependence, which are the kinds of aggressive measures implied by the query. It is relevant because it suggests what a stronger-than-baseline policy package would look like.
6. This passage refers to sustainable transportation planning and emission reduction targets, which is directly relevant to evaluating policy ambition and target-setting. It provides general evidence about whether local governments have formal transport planning instruments, but it does not specifically address Yantian Port or the Shenzhen Master Plan.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1986 ms)
1. This passage states Yantian Port’s planned shift toward railways and waterways for container transport, which is central to understanding what will enable or constrain road-to-rail intermodal expansion at Yantian.
2. It identifies key barriers to rail intermodal adoption in China—uncompetitive railway pricing, underdeveloped intermodal services, and limited rail service quality—providing direct constraints that could affect Yantian’s road-to-rail expansion.
3. It discusses tactics to increase rail-and-water intermodal freight by shifting bulk and promoting intermodal freight, implying that infrastructure investment and service capability are necessary to overcome adoption barriers relevant to Yantian.
4. It specifically recommends promoting sea-to-rail/sea-to-water intermodal services at the Shenzhen (Yantian) port, which helps frame operational and policy measures that address barriers to intermodal expansion.

**gpt-5.4-mini** (1963 ms)
1. This passage is directly relevant because it mentions Yantian Port and states a future reliance on railways and waterways for container transport, which frames the intermodal expansion being asked about. Although it does not list barriers explicitly in the visible text, it provides the core context for the port-specific rail-water strategy.
2. This passage is directly relevant because it identifies general barriers to rail-based freight intermodal expansion in China, including uncompetitive railway pricing, underdeveloped intermodal services, and limited rail service quality. These obstacles help explain what could hinder road-to-rail expansion at Yantian Port.
3. This passage is only indirectly relevant because it gives a broad decarbonization strategy that includes shifting freight from roads to railways and waterways and investing in intermodal infrastructure. It supports the topic of intermodal transport expansion, but it does not specify barriers at Yantian Port.
4. This passage is directly relevant because it recommends promoting sea-to-rail and sea-to-water intermodal services at Shenzhen port, which is closely connected to Yantian Port. The recommendation implies the type of intermodal expansion under discussion, though it does not explicitly enumerate barriers.

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (7975 ms)
1. Discusses that achieving additional carbon reductions requires aggressive measures including greater freight mode shift and upstream decarbonization of grid emissions. This directly connects to comparing electrification (drayage) with rail/water mode-shift strategies for well-to-wheel CO2 reductions.
2. Provides a sector-wide decarbonization framing for road transport, including timing and the role of stronger measures (which would encompass higher electrification levels for drayage trucks). While it does not quantify the Yantian-specific 95% figure, it supports how road electrification affects emissions trajectories.
3. Emphasizes that China’s policies must increase ambition on structural changes and vehicle electrification, which underpins analyzing what a high electrification penetration (like 95% by 2035) would imply. It does not provide the specific Yantian drayage result or explicit rail/water comparisons.
4. Focuses on policies accelerating zero-emission heavy-duty trucks (e.g., BET/FCET) and related infrastructure, which is the core technology lever for drayage truck electrification. However, it does not give the needed well-to-wheel CO2 decline at 95% by 2035 for Yantian, nor does it quantify rail/water shift impacts.
5. States that vehicle electrification alone is insufficient and that multiple measures are needed, highlighting the importance of combining road electrification with broader decarbonization actions (including upstream and possibly mode shift). It gives transport emissions context but does not quantify the specific scenario (95% drayage electrification by 2035 at Yantian) or compare directly to rail/water mode shift measures.
6. Recommends improvements to public transit, walking, and cycling environments, which relates to passenger mobility rather than freight drayage or rail/water mode shift. It is only loosely connected to the concept of mode shift for emissions, not the query’s freight-focused comparison.
7. Lists port and transport low-carbon initiatives and mentions electrification targets for vehicles and distributed energy pilots at ports, which is relevant to decarbonization pathways at maritime facilities like Yantian. However, it does not provide a well-to-wheel CO2 calculation for drayage truck electrification reaching 95% by 2035 or a quantified comparison to rail and water mode shift.
8. Proposes quantified sectoral targets (green fuels and transport energy reduction) by 2035 across all modes, offering a high-level benchmark for what “mode shift vs electrification/energy changes” could accomplish. It does not provide Yantian drayage-specific well-to-wheel CO2 decline at 95% electrification nor mode-shift-by-rail/water quantified results.
9. Contains information about counts of public transport in NDCs and is not directly about freight drayage electrification, well-to-wheel CO2, or rail/water mode shift measures. Therefore it does not help compute the requested comparison.
10. Presents scenario analysis impacts of electrification on percentage CO2 emissions reduction by 2030 and 2050, which is conceptually relevant to estimating the effect of reaching a high electrification penetration. It still lacks Yantian port drayage-specific values and does not include explicit rail/water mode-shift measures for comparison.
11. Explicitly states that emission reduction potential increases when paired with train electrification and grid modernization, and it calls to electrify freight rail (a key rail comparison in the query). While it does not provide the exact numerical well-to-wheel CO2 decline for Yantian drayage at 95%, it directly supports the rail-mode-shift/rail-electrification comparison dimension.
12. Provides a case-study feasibility analysis of zero-emission trucks in urban/regional delivery, which can support assumptions about electrification impacts on emissions. It does not cover drayage at Yantian specifically, nor does it provide the rail and water mode-shift comparison requested.
13. Highlights Freight TDM aimed at shifting freight from trucks to rail, directly aligning with the query’s need to compare against rail mode-shift measures. It does not provide the quantified well-to-wheel CO2 decline for 95% drayage electrification by 2035 at Yantian, so it contributes only to the rail mode-shift component.
14. Gives assumptions (vehicle life, etc.) used in a zero-emission truck techno-economic analysis, which could be necessary to model well-to-wheel emissions under electrification scenarios. It still does not provide the Yantian-specific 95% by 2035 CO2 decline or quantitative rail/water mode-shift comparison.
15. Focuses on pathways for decarbonizing road transport in Guangdong, including incentives for zero-emission logistics vehicles. This is relevant to how electrification could be accelerated, but it does not provide Yantian drayage-specific well-to-wheel CO2 reductions at 95% by 2035 nor explicit rail/water mode-shift quantification.

**gpt-5.4-mini** (4374 ms)
1. This passage is directly relevant because it discusses reducing remaining carbon emissions through greater freight mode shift and grid decarbonization, which is the same policy context as the query. It likely frames the comparison between electrification and mode-shift measures at a port.
2. This passage is only broadly related because it concerns decarbonizing China's road transport sector, but the excerpt does not mention Yantian Port, drayage trucks, or the specific 95% electrification scenario. It provides sector background rather than the requested emissions estimate.
3. This passage is indirectly relevant because it emphasizes vehicle electrification and structural changes as necessary for carbon neutrality. However, it does not give the specific well-to-wheel CO2 reduction for Yantian Port or compare electrification with rail and water mode shift.
4. This passage is only tangentially relevant because it is about zero-emission heavy-duty trucks in China, which may inform drayage truck electrification pathways. The visible excerpt does not provide the emissions decline figure or the comparison with rail and water mode shifts.
5. This passage is indirectly relevant because it addresses net-zero transport in China and the limits of relying on vehicle electrification alone. It provides general modeling context but not the port-specific emissions reduction asked about in the query.
6. This passage is only loosely related because it discusses net-zero road transport in Hong Kong and may include freight-related recommendations. It does not appear to address Yantian Port, drayage electrification, or the specific CO2 decline comparison.
7. This passage is indirectly relevant because it mentions port low-carbon pilots and electrification of on-site vehicles, which is adjacent to drayage truck electrification. But the excerpt does not provide the requested Yantian Port emissions reduction or mode-shift comparison.
8. This passage is relevant as a general policy benchmark because it discusses a transport-sector shift toward green fuels and reduced energy use by 2035. It is not port-specific, but it may provide context for comparing electrification with broader mode-shift measures.
9. This passage is not directly relevant to the query because it focuses on public transport in NDCs rather than freight, ports, or truck electrification. It offers general transport policy context at best.
10. This passage is indirectly relevant because it contains a table on the CO2 reduction impact of electrification in transport scenarios. However, the excerpt shown does not specify drayage trucks, Yantian Port, or the rail and water mode-shift comparison requested.
11. This passage is relevant because it explicitly mentions that emission reductions increase further when paired with train electrification and freight mode shifts. It supports the comparison aspect of the query, especially the role of rail measures relative to electrification.
12. This passage is only indirectly relevant because it is a case study on zero-emission trucks in Guangdong Province, which is geographically and sectorally adjacent to Yantian Port. The excerpt shown does not include the specific emissions decline or mode-shift comparison.
13. This passage is indirectly relevant because it explicitly states freight TDM involves shifting freight from trucks to rail. That makes it useful background for the rail mode-shift comparison in the query, though it does not address Yantian Port or the emissions percentage.
14. This passage is only indirectly relevant because it is methodological material from the same Guangdong truck feasibility study. The excerpt does not include the emissions outcome or the port-specific scenario needed to answer the query.
15. This passage is directly relevant because it discusses adoption of zero-emission logistic vehicles in Guangdong cities, which is closely related to drayage truck electrification in the region. It may help contextualize the port-related electrification pathway, though the excerpt itself does not give the exact emissions decline figure.

## batch-relates

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1534 ms)
1. Projects zero-emission heavy-duty truck penetration in China’s regional and long-haul scenarios through 2035.
2. Provides model parameters and sources used for 2035 penetration calculations, supporting the projected rates.
3. Discusses broader road transport decarbonization, but not specific new energy heavy-duty truck penetration rates to 2035.

**gpt-5.4-mini** (1156 ms)
1. Gives projected ZET penetration in China’s long-haul freight, reaching about 15%–53% by 2035 under strengthened policies.
2. Contains truck activity assumptions and abbreviations, not penetration projections.
3. Discusses China’s road transport decarbonization and NEV deployment, but not 2035 heavy-duty truck penetration.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (5089 ms)
1. Reports TCO parity between battery-electric and diesel heavy trucks in Guangdong before MY2025 and for which truck class.
2. Provides context on decarbonizing road transport but snippet lacks specific China heavy-truck BEV-versus-diesel TCO figures.
3. Cites a dedicated ICCT TCO study comparing battery-electric, fuel-cell, and diesel heavy trucks in China.
4. Discusses policy acceleration for zero-emission heavy-duty trucks in China but snippet doesn’t quantify BEV-versus-diesel TCO.
5. Additional references within the policy paper; snippet doesn’t include comparative TCO results.
6. Suggests BEV trucks in China are projected to achieve lower total costs, but snippet cuts off before comparison details.
7. Discusses China road transport decarbonization pathways and references EV cost analysis, not explicit heavy-truck BEV/diesel TCO.
8. Links BEV heavy-duty truck adoption in Shenzhen ports to TCO versus diesel equivalents.
9. Cites the same ICCT TCO study for heavy trucks in China, relevant to BEV versus diesel comparison.
10. Shows that certain BEV heavy trucks can reach 1:1 TCO parity with diesel under ideal replacement assumptions in Beijing analysis.
11. Uses TCO terminology for scenario analysis but snippet doesn’t provide BEV versus diesel heavy-truck TCO comparison.
12. Defines TCO within a net-zero road transport framework for Hong Kong but not China heavy-truck BEV-versus-diesel results.
13. Introduces a bus cost tool methodology comparing diesel and battery-electric total cost, but for transit buses not heavy trucks.
14. General evidence that electric heavy vehicles can reduce lifetime cost versus diesel, but not China heavy-truck specifics.
15. Explains how TCO is calculated including battery replacement, but doesn’t compare China heavy-duty BEV and diesel.
16. Provides methodology and emission factors rather than direct heavy-truck BEV versus diesel TCO comparison.
17. Cites reduced cost of ownership for electric buses versus conventional buses, not heavy-duty truck TCO in China.
18. Discusses TCO gaps between electric and diesel school buses, not China heavy-duty truck TCO comparison.
19. Presents a comparative financial tool for zero-emission versus diesel trucks, though focused on India rather than China.
20. Auto-rickshaw electrification includes TCO comparison between ICE and electric vehicles, not China heavy-duty trucks.

**gpt-5.4-mini** (2534 ms)
1. States battery electric trucks reach TCO parity with diesel in Guangdong before 2025.
2. Lists a source comparing heavy-truck TCOs for battery-electric and diesel trucks in China.
3. Cites the China heavy-truck TCO study comparing battery-electric, fuel cell, and diesel trucks.
4. Discusses zero-emission truck policies, not the specific TCO comparison.
5. Mentions heavy-duty truck decarbonization research, but gives no TCO results.
6. Says studies suggest Chinese battery electric trucks will achieve total cost parity with diesel.
7. References the China electric-vs-diesel truck cost study without reporting results.
8. Notes battery-electric HDT adoption depends on TCO versus diesel equivalents in Shenzhen ports.
9. Cites the heavy-truck TCO study for China, including battery-electric and diesel trucks.
10. Shows some battery-electric heavy trucks can reach TCO parity with diesel in Beijing.
11. Analyzes zero-emission freight scenarios, but not the China truck TCO comparison.
12. Mentions TCO in a Hong Kong road transport framework, not China heavy-duty truck costs.
13. Compares bus TCOs across fuels, not heavy-duty trucks in China.
14. Generalizes that electric heavy-duty vehicles can be cheaper than diesel in some studies.
15. Explains bus TCO methodology, unrelated to China truck comparison.
16. Provides China emission factors, not truck ownership-cost comparisons.
17. Shows electric buses can reduce ownership costs, not trucks in China.
18. Mentions a TCO gap between electric and diesel school buses, not China trucks.
19. Compares zero-emission and diesel trucks in India, not China.
20. Explains auto-rickshaw TCO, unrelated to heavy-duty trucks in China.

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (2473 ms)
1. Reports regional delivery reaching 2–17% ZET share by 2030 while long-haul remains nascent through 2035.
2. Uses scenario assumptions (e.g., 30% residual value) relevant for comparing regional versus long-haul ZET adoption outcomes.
3. Discusses that HDV NEV adoption reaches tipping points later due to technology and policy constraints, implying scenario differences.
4. Links zero-emission vehicle promotion to greatest decarbonization potential, but not explicitly adoption differences by route length.
5. Analyzes freight-zone scenarios affecting long-haul and regional-haul transportation, implying adoption potential impacts.
6. Shows BEVs better for most urban/regional delivery, while FCEVs suit long-range, suggesting different adoption potential.
7. Urban and regional delivery case study focuses on zero-emission trucks, but snippet lacks explicit regional vs long-haul comparison.
8. Continuation of Guangdong zero-emission truck feasibility study; snippet is bibliographic and doesn’t compare adoption potential.
9. Provides financial assessment tool for single ZET vs ICE truck, offering no explicit regional-long-haul adoption potential comparison.

**gpt-5.4-mini** (1554 ms)
1. Compares modest regional adoption with nascent long-haul adoption, showing regional potential is much higher.
2. Contains scenario abbreviations for regional and long-haul cases, but no adoption comparison.
3. Notes different decarbonization paces by duty cycle, implying regional trucks adopt earlier than long-haul.
4. Discusses zero-emission vehicle potential generally, not regional versus long-haul truck adoption.
5. Mentions long-haul/regional-haul impacts, but not adoption potential differences.
6. States BEVs suit city delivery while FCEVs fit long-range hauling, suggesting scenario-specific adoption differences.
7. Focuses on urban and regional delivery feasibility, without long-haul adoption comparison.
8. Focuses on urban and regional delivery feasibility, without long-haul adoption comparison.
9. Describes a financial comparison tool for single trucks, not adoption potential by scenario.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (3008 ms)
1. Provides residual-value assumptions impacting ZET cashflows and cost competitiveness, which influence payback timing comparisons versus diesel.
2. States TCO parity timings for battery electric tractors in Guangdong, enabling inference of payback periods before MY2025.
3. Discusses residual-value sensitivity scenarios for zero-emission trucks, affecting payback-period calculations relative to diesel.
4. Reports battery electric trucks reaching TCO parity with ICEV before MY2027 in several use cases, implying payback near parity.
5. Defines payback period as a discounted-cash-flow metric for comparing diesel and e-trucks, but lacks China-specific numbers here.
6. Generic decarbonization strategies with no explicit payback-period comparison between BEV semi-trucks and diesel.
7. Cites a total cost of ownership white paper for battery electric, fuel cell, and diesel heavy trucks, potentially containing payback.
8. Shows Chinese cost differences and TCO breakeven distances for electric versus diesel trucks, supporting payback-period comparison.
9. Discusses market context and technology limits for Chinese electric trucks, without payback-period results.
10. References heavy-truck TCO literature but provides no direct payback-period figures for BEV versus diesel.
11. Mostly policy-focused and cites TCO sources, but does not provide explicit payback periods for BEV semi-trucks in China.
12. Port case study focuses on freight modal shifts and diesel emissions, not payback-period comparisons for BEV semis.
13. Uses TCO parity concepts to accelerate ZEV adoption, but does not report China payback-period comparisons for BEV semis.

**gpt-5.4-mini** (1964 ms)
1. Cites lower residual values affecting BET cost competitiveness, but gives no payback period.
2. States BETs reach TCO parity before MY2025 in Guangdong, not payback periods versus diesel.
3. Mentions residual-value assumptions for ZET scenarios, without payback period data.
4. Says BETs reach TCO parity before MY2027 in some uses, lacking payback periods.
5. Defines payback period concept for truck comparisons, but provides no China-specific figures.
6. General China road-transport policy review; no battery versus diesel payback periods.
7. References a Chinese heavy-truck TCO study likely containing the requested payback periods.
8. Gives Chinese BEV cost gaps and mileage thresholds, but not payback periods.
9. Discusses heavy-truck electrification in China generally, without payback period figures.
10. Cites the key China heavy-truck TCO study, but includes no payback numbers.
11. Lists the relevant China heavy-truck TCO white paper, without payback details.
12. China port study on diesel trucks and low-carbon options; no payback periods.
13. Discusses BEV/HGV TCO parity in Hong Kong, not China payback periods.

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (5944 ms)
1. Reports 17%–45% of trips replace private motorized vehicles, indicating some car-taxi-ride-hailing substitution.
2. Provides passenger mode-share changes in China but not substitution shares from bike-share.
3. States 17%–45% of trips replaced private motorized vehicles and details transit connections.
4. Focuses on electric mobility roadmaps in Vietnam, not bike-share trip replacement in China.
5. Discusses bicycle sharing in China but lacks quantification of replacement of specific trip types.
6. Describes bike-sharing technology evolution and deployment, without replacement shares for China.
7. Covers net-zero policy and bike-sharing adoption rates, not trip replacement shares.
8. Presents Johannesburg mode shares, unrelated to China bike-share trip replacement.
9. Discusses ride-hailing replacement dynamics generally, not bike-share in China.
10. Hong Kong decarbonization context for private cars and taxis, not bike-share substitution in China.
11. Addresses safe access and cycling safety in China, not the share of trips replacing cars/taxis.
12. Methodology guide for transport emissions by mode, not bike-share trip replacement shares.
13. Examines ride-hailing competition and mode substitution generally, not bike-share replacement in China.
14. Bike-sharing lessons from India, with no China-specific replacement of car/taxi/ride-hailing trips.
15. Provides framework for assessing micromobility GHG impacts, not China trip replacement shares.
16. Notes data gaps on whether ride-sharing trips replace others, not bike-share replacement in China.
17. General discussion of shared mobility accessibility benefits, without quantified replacement shares for China.
18. Presents Surabaya mode shares without any connection to China bike-share substitution.
19. Describes demand-responsive transit models including bikes, but provides no China replacement percentages.
20. Models electric vehicle grid impacts in China, unrelated to bike-share trip replacement.
21. Overview of informal services in Latin America, not bike-share or China substitution.
22. Gives China bike-sharing service coverage and car ownership trends, not replacement shares of trips.
23. Trip mode shares for Guadalajara interventions, not bike-share replacement in China.
24. Commuting mode choice in Bengaluru, unrelated to China bike-share trip replacement.
25. Bus aggregator impact modeling for India, unrelated to China bike-share replacement shares.
26. Discusses transport demand management in Mexico, not bike-share substitution in China.

**gpt-5.4-mini** (3643 ms)
1. Reports 17%–45% of bike-share trips replaced private motorized trips in Chinese cities.
2. Discusses China’s transport mode shares, but not bike-share trip substitution rates.
3. States 17%–45% of trips replaced private motor vehicles, including car, taxi, and ride-hailing.
4. Mentions commute mode targets and taxis, but not Chinese bike-share replacement shares.
5. Cites Hangzhou’s large bike-share system, without substitution-share data for private car, taxi, or ride-hailing.
6. Explains dockless bike sharing’s growth in China, not its trip-replacement share.
7. Notes bike-sharing expansion in China, but gives no replacement-share estimate.
8. Shows Johannesburg travel mode shares, unrelated to Chinese bike-share substitution.
9. Discusses whether ride-hailing replaces other trips, but not Chinese bike-share shares.
10. Provides Hong Kong vehicle counts, not bike-share replacement shares in China.
11. Shows bicycle safety for transit access in China, not trip substitution percentages.
12. Lists vehicle mode variables for emissions calculations, unrelated to bike-share replacement share.
13. Discusses ride-hailing as a substitute mode, but not Chinese bike-share trip shares.
14. Notes bike-sharing opportunities in India, not China’s replacement-share figures.
15. Guides micromobility emissions assessment, without China-specific trip replacement shares.
16. Says ride-sharing may replace other trips, but offers no China bike-share percentages.
17. Mentions shared mobility as access expansion, not bike-share substitution in China.
18. Shows Surabaya mode shares, unrelated to Chinese bike-share replacement.
19. Describes shared mobility as alternatives to private vehicles, not China bike-share shares.
20. Presents EV assumptions for taxis, unrelated to bike-share trip replacement.
21. Lists informal service modes, not bike-share substitution in China.
22. Repeats China bike-sharing growth, but not replacement shares for car, taxi, or ride-hailing.
23. Shows Guadalajara mode shares, unrelated to Chinese bike-share replacement.
24. Gives Bengaluru commuting patterns, not Chinese bike-share substitution shares.
25. Discusses bus aggregators and taxi costs, not bike-share replacement shares.
26. Mentions shifting trips to cycling, but not China-specific replacement-share estimates.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (3523 ms)
1. Quantifies dockless bike sharing in China as reducing CO₂ by 4.8 million tonnes annually.
2. Reports dockless bike sharing in China reduces CO₂ by about 4.8 million tonnes per year.
3. Discusses road transport decarbonization strategies, but not bike-sharing CO₂ reductions.
4. Provides context on bicycle sharing and safety/health impacts in cities, not CO₂ reductions in China.
5. Covers bicycle-sharing scale and air-pollution/traffic-crash findings, without China bike-sharing CO₂ reduction estimates.
6. Gives broad urban decarbonization modeling, but does not attribute CO₂ reductions to bike-sharing in China.
7. Addresses transport CO₂ accounting and policy targets in China, not bike-sharing-specific reduction amounts.
8. Explores bike-sharing technology and integration, with no CO₂ reduction attributed to China bike-sharing.
9. Provides methodology for transport emissions assessment, not a China bike-sharing CO₂ reduction figure.
10. Analyzes road transport emissions in China and decarbonization pathways, not bike-sharing CO₂ reduction attribution.
11. Discusses emissions accounting approaches for micromobility services, not quantified CO₂ reduction from China bike-sharing.
12. Scenario analysis for India transport decarbonization, unrelated to China bike-sharing CO₂ reduction attribution.
13. Explains how bicycle sharing CO₂ is calculated in India, not measured reductions from China.
14. Provides net-zero context for China cities, without attributing CO₂ reductions to bike-sharing.
15. Focuses on zero-emission trucks in Guangdong, not bike-sharing CO₂ reduction amounts.

**gpt-5.4-mini** (1992 ms)
1. States bike-sharing in China reduces CO2 by 4.8 million tonnes annually.
2. Chinese summary repeats the 4.8 million tonnes annual CO2 reduction figure.
3. Discusses China transport decarbonization, not bike-sharing CO2 reductions specifically.
4. Mentions China's large bike-share systems and health benefits, but not CO2 reduction amount.
5. Cites China's largest bike-share systems, but gives no CO2 reduction estimate.
6. About national urban decarbonization targets, unrelated to bike-sharing emissions savings.
7. Focuses on transport emissions accounting, not bike-sharing CO2 reduction figures.
8. Discusses bike-sharing integration with transit, without stating CO2 reduction amounts.
9. General transport emissions methodology, not bike-sharing-specific CO2 savings.
10. Addresses China's road transport emissions broadly, not bike-sharing reduction totals.
11. Explains micromobility emissions accounting, not a China bike-sharing CO2 figure.
12. Discusses shared mobility policies for India, not China bike-sharing CO2 reductions.
13. Shows Indian bike-sharing CO2 calculations, offering a method but not China's amount.
14. Gives China's urban emissions context, but no bike-sharing reduction estimate.
15. About zero-emission trucks, unrelated to bike-sharing CO2 reductions.

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (3364 ms)
1. Report analyzes how dockless bike-sharing changes travel and mobility patterns across Chinese cities.
2. Chinese WRI report overview focuses on shared bike impacts on urban mobility and people’s travel behavior.
3. Provides context on dockless bike-sharing emergence in China, supporting background for travel-behavior effects.
4. Discusses bike-sharing scale and safety/health effects, relevant but not specific to Chinese travel behavior changes.
5. Gives China bike-sharing system examples and cycling impacts, but not targeted behavioral analysis for Chinese cities.
6. Examines road transport emissions and mode-share changes in China, potentially relevant but not dockless-bike-specific.
7. Design manual cites bike-sharing references but addresses public transport access safety, not dockless travel behavior.
8. Notes widespread presence of shared bikes and broader car/travel context in China, without behavioral mechanisms.
9. Methodology for transport emissions at city level, not travel behavior effects of dockless bike-sharing.
10. City guide on environmental impacts of shared micromobility, not how behavior changes in Chinese cities.
11. International roadmap for electric mobility in Vietnamese cities; no Chinese dockless bike-sharing behavior evidence.
12. Discusses first-mile/last-mile sharing and collaborations, relevant framework but not dockless bike-sharing in China.
13. Explains demand-responsive transit and shared mobility concept categories; lacks Chinese dockless bike-sharing behavioral findings.
14. Covers dockless PBS implementation in India, offering technology context rather than Chinese travel behavior impacts.
15. Cycling scheme lessons for Mexico emphasize mode shares and planning; not dockless bike-sharing behavior in China.
16. Principles for safe cycling during COVID cite cycling uptake, but not dockless bike-sharing effects in China.
17. Climate policy coverage for local governments and commute decisions, not dockless bike-sharing travel behavior in Chinese cities.

**gpt-5.4-mini** (2566 ms)
1. Analyzes how dockless bike-sharing changes Chinese urban travel patterns and access.
2. Chinese title page for the same study on dockless bike-sharing impacts.
3. Mentions dockless bike-sharing’s rapid growth in China, not travel behavior effects.
4. Gives background on bike sharing’s health and safety benefits, not Chinese travel behavior.
5. Cites Chinese bike-sharing scale and active travel benefits, but not dockless-specific effects.
6. Discusses passenger transport mode shifts in China, unrelated to dockless bikes specifically.
7. References a shared-bike white paper for transit access planning, not behavior impacts.
8. Notes shared bikes’ popularity in Chinese cities, without travel-behavior analysis.
9. Provides city driving assumptions for emissions modeling, unrelated to bike-sharing behavior.
10. Explains evaluating dockless micromobility environmental impacts, not travel behavior changes.
11. Focuses on electric mobility roadmaps in Vietnam, unrelated to Chinese bike-sharing.
12. Discusses first-mile/last-mile mobility patterns, which dockless bikes can help serve.
13. Covers shared mobility generally, without dockless bike-sharing impacts in China.
14. Shows dockless bike-sharing enabling rapid citywide rollout in India, not Chinese travel behavior.
15. Reviews cycling scheme lessons for sustainable mobility, not dockless behavior effects in China.
16. Discusses cycling’s rise and supporting infrastructure during COVID, not dockless bike-sharing.
17. Mentions transportation and commute policy, not dockless bike-sharing travel effects.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1767 ms)
1. Provides a Shenzhen-focused Yantian Port low-carbon analysis, informing feasibility but not Shenzhen Master Plan 2035 mode-shift targets.
2. States that mode-shift requires more proactive measures beyond a stated-policy trajectory in Guangdong contexts.
3. Defines the “Stated_policy” versus deeper transport-structure scenarios with greater mode shift, enabling comparison to targets.
4. Argues mode shift to public transit under a stated-policy scenario may stall or reverse in dense cities, implying extra measures.
5. Describes “pull-and-push” policies to shift transport modes from private cars toward public transit and rail.
6. Discusses how local governments set transportation emission targets and sustainable plans, but not Yantian/Shenzhen mode-shift specifics.

**gpt-5.4-mini** (1323 ms)
1. Analyzes Yantian Port transport emissions but not whether Shenzhen targets are achievable.
2. Says Shenzhen needs more proactive mode-shift measures in deeper decarbonization scenarios.
3. Defines the Stated Policy scenario used to judge transport-mode-shift ambition.
4. States major cities may reach over 70% green transport mode share by 2030 under stated policy.
5. Lists policy tools that push travelers toward public transit and away from cars.
6. Shows how local governments set transport emission-reduction targets and planning policies.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1825 ms)
1. Reports Yantian Port plans major reliance on rail and waterways, implying capacity planning enables intermodal growth.
2. Identifies uncompetitive rail pricing and underdeveloped intermodal services and quality as barriers to rail intermodal adoption.
3. Suggests barriers can be addressed via investing in intermodal infrastructure, improving connectivity, and rationalizing pricing/scheduling.
4. Proposes promoting sea-to-rail/sea-to-water intermodal services at Shenzhen port, indicating regional operational focus but not specific Yantian barriers.

**gpt-5.4-mini** (1182 ms)
1. Describes Yantian Port’s future shift toward rail and waterways, but not barriers to expansion.
2. Lists China-wide obstacles to rail intermodal growth: pricing, weak services, and poor rail quality.
3. Recommends investments and pricing reforms, implying infrastructure and service gaps as barriers.
4. Mentions promoting sea-to-rail intermodal services at Shenzhen port, without stating specific barriers.

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (4520 ms)
1. Directly discusses port transportation decarbonization measures like road-to-rail and upstream grid decarbonization, relevant for comparing mode shift impacts.
2. Provides China-wide decarbonization decomposition showing electrification plus structural mode-shift contributions over time.
3. Lists mode-share and electrification targets for decarbonization, enabling approximate comparison of electrification vs structural shifts.
4. Focuses on policy and technical aspects for zero-emission trucks by 2035, but not Yantian-specific well-to-wheel CO2 percentages.
5. States that reaching net-zero requires both heavy-duty electrification and major freight mode shifts like road-to-rail/road-to-water.
6. Generalizes net-zero road transport pathways but lacks Yantian port drayage and explicit well-to-wheel CO2 decline figures.
7. Mentions low-carbon port pilots and mode-share targets (rail and water), indirectly supporting rail/water comparison.
8. Proposes sector targets including electrification and shifts to rail, offering context for mode-shift comparisons, not drayage-specific impacts.
9. Addresses public transport in NDCs without freight drayage or Yantian well-to-wheel CO2 calculations.
10. Includes scenario table inputs for emissions reduction by electrification, but not port drayage well-to-wheel or rail/water shift measures.
11. Notes higher road share at the expense of rail/waterborne modes and the mitigation benefit of electrifying rail, supporting qualitative comparison.
12. Zero-emission truck feasibility for delivery cases, but no well-to-wheel CO2 decline or mode-shift comparison for Yantian.
13. Proposes freight TDM aimed at shifting freight from trucks to rail, relevant to mode-shift comparisons but not CO2 magnitudes.
14. Provides assumptions for zero-emission truck feasibility in Guangdong, not well-to-wheel CO2 decline or Yantian rail/water comparisons.
15. Suggests accelerating zero-emission drayage trucks in Guangdong municipal contexts, indirectly relevant but lacks Yantian-specific CO2 decline and rail/water quantification.

**gpt-5.4-mini** (2183 ms)
1. Gives Shenzhen port results and says road-to-rail offers the largest decarbonization potential.
2. Provides national transport decarbonization shares, but not Yantian-specific emissions decline figures.
3. Mentions structural freight shifts and vehicle electrification targets, without Yantian port details.
4. Discusses zero-emission heavy-duty truck policies, not the requested emissions comparison.
5. Explains that 2035 electrification alone is insufficient and freight shifts are needed.
6. Addresses Hong Kong road transport pathways, unrelated to Yantian Port calculations.
7. Lists Chinese port electrification and rail-water freight targets, but no CO2 reduction estimate.
8. Discusses transport-wide targets and rail shifts, not the specific port scenario.
9. Cites public transport electrification in NDCs, unrelated to drayage at Yantian.
10. Shows electrification impacts and freight rail assumptions, but not Yantian drayage results.
11. Notes freight rail and waterborne shifts reduce emissions, supporting the comparison concept.
12. Analyzes zero-emission trucks in Guangdong, likely relevant but not the emissions comparison.
13. Discusses shifting freight from trucks to rail, but not Yantian port outcomes.
14. Analyzes zero-emission trucks in Guangdong, with no Yantian emissions decline figures shown.
15. Recommends zero-emission drayage trucks in Shenzhen, relevant to Yantian but not quantified here.

## alignment

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1726 ms)
1. The most relevant Chinese report projects ZET (zero-emission heavy-duty trucks) market penetration for 2030 in regional delivery (RD) at ~2%–17%, but does not clearly state the 2035 penetration rate.
2. Another highly relevant China-focused source discusses policies and infrastructure assumptions (e.g., annual vehicle kilometers, DC fast charging), yet the provided excerpt lacks the requested 2035 penetration metric.
3. A third, lower-relevance piece offers broad carbon-neutral transport strategies and notes projections are author-calculated, but provides insufficient evidence for 2035 market penetration.
4. To improve, refine the query to request “2035 penetration rate” and specify “zero-emission heavy-duty trucks / new energy heavy trucks (ZET)” to surface the exact 2035 percentage.

**gpt-5.4-mini** (1575 ms)
1. The strongest result is directly on China’s heavy-duty truck market through 2035, but it mainly reports a no-policy 2030 regional-delivery penetration range of about 2%–17%, not a single 2035 market share.
2. The other highly relevant report appears to cover policy pathways and long-haul scenarios, yet the excerpt shown does not expose the 2035 penetration figures, so the exact projection remains incomplete.
3. Relevant sources are in Chinese, which is useful for this topic, but the set is narrow and may miss clearer 2035 estimates, especially for national-level or scenario-specific penetration rates.
4. Refine the query with terms like ‘2035 penetration rate,’ ‘regional delivery,’ ‘long-haul,’ ‘zero-emission heavy-duty trucks,’ or ‘policy scenario’ to surface the precise forecast table or chart.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (3395 ms)
1. The most relevant sources are Chinese studies focused on China-specific TCO comparisons for heavy trucks (e.g., Guangdong port/drayage and regional delivery use cases).
2. Coverage seems strong on feasibility and policy context, but likely under-specifies cross-segment assumptions (duty cycle, routes, utilization, and electricity pricing) that drive TCO gaps.
3. Because nearly all results are published in Chinese, evidence may be harder to verify or benchmark against widely used global TCO models (fuel cost, maintenance, residual value, and incentives).
4. Improve results by narrowing to “China heavy-duty truck TCO diesel vs battery-electric” plus “battery replacement,” “charging infrastructure cost allocation,” and “incentives/subsidies” for the target truck class.

**gpt-5.4-mini** (1536 ms)
1. The results are strongly centered on China and heavy-duty trucking economics, with a direct match in a cited study on total cost of ownership for battery-electric, fuel cell, and diesel trucks in China.
2. Relevant sources include publications in Chinese, but the snippet mix suggests some retrieved items focus more on policy and zero-emission truck deployment than on a direct BET-versus-diesel cost comparison.
3. Coverage is good on regional and urban delivery contexts, especially Guangdong and China-wide decarbonization strategy, but long-haul, specific assumptions, and diesel price/fuel sensitivity are not clearly surfaced.
4. To sharpen results, ask for 'TCO comparison of battery electric vs diesel heavy-duty trucks in China' plus the specific use case, year range, or province, and include 'sensitivity analysis' if you want cost drivers.

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1844 ms)
1. Regional delivery shows modest zero-emission truck (ZET) uptake (2–17% market share by 2030 without incentives), indicating a low-to-mid adoption potential baseline.
2. Long-haul adoption potential appears more constrained in the retrieved set, with attention to policy incentives, technology limits, and TCO parity timing shaping uptake rather than immediate market pull.
3. Scenario framing in China-specific studies suggests regional logistics can reach earlier, smaller penetration, while long-haul faces higher cost/feasibility barriers, requiring stronger incentives to accelerate.
4. Because most sources are Chinese and evidence details differ by paper, compare assumptions (e.g., retail-price guarantees, residual value, and infrastructure constraints) before concluding size of the gap.

**gpt-5.4-mini** (1415 ms)
1. The results are mostly on China and directly compare regional delivery with long-haul trucking, especially the flagship study on zero-emission heavy-duty trucks; relevant sources also include Chinese-language publications.
2. The key difference appears to be that regional transport reaches meaningful adoption earlier and at higher shares, while long-haul remains nascent or slower because of technology and cost constraints.
3. Coverage is strong for scenario-based adoption potential, but weaker on cross-country comparisons, fleet economics detail, and any non-China evidence on regional versus long-haul dynamics.
4. To sharpen results, ask for specific metrics such as market share, TCO parity, or policy incentives, and specify whether you want China-only or global truck scenarios.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (2002 ms)
1. The most relevant Chinese sources discuss battery-electric truck payback/financing within China-specific techno-economic models, but the provided excerpts don’t show actual payback-period numbers.
2. One source mentions residual value assumptions (e.g., diesel retaining ~30% post-use), which strongly affects payback; however, the excerpt doesn’t link to a China payback result.
3. A Guangdong case-study indicates BETs can reach TCO parity vs ICEV before MY2027, implying payback could be <2027 in those use cases, but the evidence for payback timing is not shown.
4. To improve results, query specifically for “payback period” plus “BET vs diesel,” and restrict to “semi-truck/tractor” and China provinces (e.g., “Guangdong”) to extract the actual payback values.

**gpt-5.4-mini** (1499 ms)
1. The results are relevant, but they focus on zero-emission heavy-duty trucks broadly rather than isolating battery electric semi-trucks versus diesel trucks in China.
2. Several sources discuss TCO parity and payback period concepts, but the excerpts shown do not provide the actual payback-period numbers you asked for.
3. Coverage is stronger for China-specific policy and Guangdong case studies; relevant publications also appear in Chinese, showing the corpus includes non-English sources.
4. To get a precise answer, narrow the query to payback period, battery electric heavy-duty or semi-trucks, diesel baseline, and a specific Chinese region or use case such as regional haul or port drayage.

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (2230 ms)
1. Only one clearly relevant result addresses mode shift in dockless bike sharing: it reports “54%” of rides are for first/last-mile connections and that “17% to 45%” replace private car, taxi, or ride-hailing.
2. The most relevant excerpt is in Chinese and provides percentages for substitution range, but the results don’t specify whether the 17%–45% is for total trips, short trips, or a specific city/timeframe.
3. Other retrieved sources appear more general (road transport decarbonization, electric mobility, safer-by-design) and lack direct evidence for China’s share of bike-share trips replacing car/taxi/ride-hailing.
4. Refine the query to include “substitution rate” / “mode shift” and “dockless” plus “17%–45%” or “replacement of private car and taxi” to find the companion methodological section and city breakdown.

**gpt-5.4-mini** (1366 ms)
1. The results are relevant but mostly estimate substitution for short trips and public transport access, not the specific share replacing private car, taxi, or ride-hailing trips in China.
2. One Chinese WRI source reports 17% to 45% of trips replaced private motorized travel, but the excerpt is incomplete and does not isolate cars, taxis, or ride-hailing.
3. Several results focus on bike-share benefits, last-mile access, health, or emissions, so they support context but not a precise modal-shift share.
4. To improve precision, search for English phrases like 'mode substitution', 'private car replacement', 'taxi replacement', 'ride-hailing', and a specific China city or survey study.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1591 ms)
1. Sources are mostly Chinese and strongly on bicycle-sharing impacts, but the provided excerpts emphasize travel substitution, health, and accessibility rather than a specific CO2 reduction figure for China.
2. One highly relevant study mentions “net annual mortality avoided,” and another references “emissions reduction” benefits, yet the excerpts shown do not quantify CO2 reduction attributable to bike-sharing.
3. Transport-sector strategy material appears more general (road transport decarbonization) and may not attribute emissions changes specifically to bike-sharing in China.
4. To improve, refine the query to request a quantified estimate (e.g., “annual CO2 avoided/mitigated (tonnes)” and the study name/authors) and specify “dockless” or “shared bikes” if applicable.

**gpt-5.4-mini** (1533 ms)
1. The strongest match is a WRI China bike-sharing study that says 17%–45% of trips replace private motorized travel, but the snippet does not give a direct CO2 total.
2. Results include Chinese-language sources, especially the same dockless bike-sharing report, which likely contains the missing emissions estimate if you open the full document.
3. Other retrieved items are broader transport-decarbonization or general bike-share context, so they support background but not the specific CO2 reduction amount.
4. Refine the query with phrases like "bike-sharing CO2 reduction estimate China" or "emissions avoided" to surface the exact quantified result rather than general benefits.

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1697 ms)
1. Sources focus specifically on Chinese dockless bike-sharing impacts (“How Dockless Bike Sharing Changes Lives”), but the provided excerpts don’t yet show concrete travel-behavior mechanisms or measured outcomes.
2. The results are geographically aligned (China) and likely behavior-relevant (DBS expansion since 2015), yet the excerpt evidence is mostly framing/overview rather than mode shift, trip chaining, or time/distance changes.
3. All cited results are in Chinese; this limits cross-validation with English or other regional studies that could strengthen causal claims or reveal counterexamples.
4. Improve by adding keywords like “mode shift,” “first/last mile,” “commuting,” “trip length,” “vehicle-kilometers,” “public transit integration,” and target cities (e.g., Hangzhou, Shanghai).

**gpt-5.4-mini** (1425 ms)
1. The top hits are strongly centered on dockless bike-sharing in Chinese cities, especially the WRI report 'How Dockless Bike Sharing Changes Lives' and its Chinese version.
2. The results speak to travel behavior changes, but the excerpts shown are mostly descriptive introductions; they do not reveal specific findings on mode shift, trip purpose, or substitution effects.
3. Relevant sources include publications in Chinese, so the corpus coverage is not limited to English, but the sample is narrow and largely duplicates the same WRI report.
4. To sharpen the search, add terms like 'travel behavior', 'mode shift', 'trip substitution', 'last-mile travel', or a specific city or timeframe in China.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1912 ms)
1. Results are mostly Chinese road-transport decarbonization studies, with limited direct linkage to Shenzhen’s 2035 port logistics mode-shift targets or Yantian-specific shift volumes.
2. Only one highly relevant item appears to analyze Yantian Port’s domestic transport and distribution emissions; it likely informs carbon impacts, not whether mode-shift targets are met.
3. A cited “Stated Policy” scenario is discussed for road transport, but it is unclear the methodology maps to Shenzhen’s Master Plan (2035) port-mode shift, or to how much additional policy beyond stated trajectories is needed.
4. Missing angles include: explicit Shenzhen/port mode-shift target numbers, baseline split (rail/truck/water), current Yantian performance, and sensitivity to operational/rail-capacity constraints.

**gpt-5.4-mini** (1791 ms)
1. The strongest result is directly about Yantian Port and port-related domestic transport emissions, so it is highly relevant to mode-shift feasibility, but the excerpt does not show the Shenzhen Master Plan target itself.
2. Several other results are China-wide road-transport decarbonization studies, which can inform whether a mere stated-policy pathway is enough, but they are not port-specific and likely understate Yantian’s local logistics constraints.
3. The corpus includes Chinese-language sources, which is useful, but the retrieved set is thin on explicit evidence about Yantian’s 2035 freight-mode shares, policy enforcement, or implementation timing.
4. Refining the query around Shenzhen/Yantian, freight mode shift, 2035 targets, and specific measures such as rail-water intermodal expansion or truck restrictions would likely surface more decisive evidence.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1948 ms)
1. One highly relevant source says Yantian’s 2035 plan depends on railways and waterways, but provides limited detail on current road-to-rail bottlenecks and near-term barriers.
2. General barriers from other sources include uncompetitive railway pricing, underdeveloped intermodal services, and limited rail service quality—likely constraints affecting road-to-rail adoption at Chinese ports.
3. Guangdong-focused material highlights promoting sea-to-rail/sea-to-water intermodal services at Shenzhen port, but does not isolate specific operational barriers (yard layout, scheduling, truck access) for road-to-rail at Yantian.
4. Risk: evidence is mostly strategic and cross-sector; without port-specific data, conclusions about Yantian’s exact road-to-rail barriers (capacity, dwell time, coordination, tariffs) remain uncertain.

**gpt-5.4-mini** (1659 ms)
1. The strongest source is a Yantian-focused Chinese passage projecting rail and water to handle over 50% of container throughput by 2035, but it gives targets more than barriers.
2. The other results add likely constraints—uncompetitive railway pricing, weak intermodal services, and limited rail service quality—but they are broad China-level evidence, not Yantian-specific.
3. Relevant sources include publications in Chinese, which broadens coverage, but there is little direct evidence on local bottlenecks such as terminal access, coordination, or capacity at Yantian Port.
4. Refine the query toward Yantian-specific barriers, such as rail access capacity, pricing, service reliability, and port-rail coordination, to get more directly actionable results.

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1776 ms)
1. Sources are largely China-focused and road-emissions oriented; they don’t quantify a Yantian Port-specific WTW CO2 decline from 95% drayage electrification by 2035.
2. Evidence on electrification is more policy/strategy-level (e.g., heavy-duty truck ZEV acceleration) and lacks the baseline truck mix, grid intensity, and mileage shares needed for WTW calculations.
3. There is some discussion of needing freight mode shift and upstream grid decarbonization, but the results don’t provide comparable, port-level rail/vessel shift impacts versus drayage electrification.
4. To improve: narrow to “port drayage electrification WTW CO2” for Yantian or Guangdong, and ask for quantitative comparisons to “rail container transfer” and “inland waterway shift” by 2035.

**gpt-5.4-mini** (1642 ms)
1. The results are only partially aligned: they discuss container-port transport decarbonization and China road transport, but none clearly give the specific Yantian Port figure for 95% drayage electrification by 2035.
2. The strongest match appears to be the port study, which mentions that cutting remaining emissions needs more freight mode shift and upstream grid decarbonization, suggesting the answer likely compares electrification against rail and water shifts.
3. Relevant sources include publications in Chinese, so the corpus coverage is broader than English-only results, but the snippet set is too thin to extract the exact emissions decline or mode-shift percentages.
4. Refine the query with Yantian Port, 'well-to-wheel,' and 'Figure ES-1' or '95% by 2035' to surface the exact quantitative comparison and avoid generic China transport mitigation studies.

## translate

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (2943 ms)
> Heading toward 2035: Research on the Deployment Potential of China’s New Energy Heavy Trucks in Regional and Long-Haul Transportation Scenarios

This report assesses the potential and policy effects of deploying zero-emission heavy-duty trucks (zero-emission heavy-duty trucks, abbreviated as ZET) in China from 2024 to 2035 in two scenarios: regional delivery (regional delivery, abbreviated as RD) and long-haul (long-haul, abbreviated as LH). The conclusions show that, under a no-policy scenario, by model year (MY) 2030 the ZET penetration rate in the RD scenario is only about 2%–17%, while the LH scenario remains in an early stage through before 2035.

Existing policies can significantly boost regional adoption dominated by battery-electric tractor trucks before 2027, but adoption may decline after subsidies expire. Among strengthened policies, reducing tolls (e.g., by 50%) is the most effective for increasing penetration rates. The next most important factors are accelerating the construction of dedicated fast-charging networks for heavy trucks and lowering the cost of overnight charging. With strengthened policies layered together, the ZET penetration rate in the RD scenario can exceed 50% during MY2027–2030, and drive substantial growth in the LH scenario during MY2032–2035 (reaching approximately 15%–53% by 2035).

The research indicates that uncertainties in operations, technology, and the price of diesel and electricity have a major impact. It recommends setting targets by scenario and by vehicle type, carefully evaluating the fiscal impact of toll reductions, prioritizing improvements to charging infrastructure for heavy trucks, and establishing a data collection and support mechanism based on operational statistics by scenario.

**gpt-5.4-mini** (1904 ms)
> Toward 2035: A Study on the Promotion Potential of China’s New Energy Heavy-Duty Trucks in Regional and Long-Haul Transport Scenarios This report assesses the potential and policy effects of promoting zero-emission heavy-duty trucks (ZETs) in China from 2024 to 2035 in regional transport (regional delivery, RD) and long-haul transport (long-haul, LH) scenarios. The findings show that under a no-policy scenario, ZET penetration in the RD scenario reaches only about 2%–17% by model year 2030, while the LH scenario remains at an early stage before 2035. Existing policies can significantly boost regional adoption, mainly of battery electric tractors, before 2027, but penetration may decline after subsidies expire. Among strengthened policies, reducing highway tolls (for example, by 50%) is the most effective measure for increasing penetration, followed by accelerating the construction of a dedicated fast-charging network for heavy-duty trucks and lowering nighttime charging costs. Under combined strengthened policies, RD scenario penetration can exceed 50% during MY2027–2030, and the LH scenario can grow significantly during MY2032–2035 (reaching about 15%–53% by 2035). The study notes that operational, technical, and oil-electricity price uncertainties have a major impact, and recommends setting targets by scenario and vehicle type, carefully assessing the fiscal impact of toll reductions, prioritizing improvements to heavy-duty truck charging infrastructure, and establishing scenario-specific mechanisms for operational data collection and support.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1411 ms)
> Cost-and-Technical Feasibility Analysis of Zero-Emission Trucks for Urban and Regional Delivery Use Cases: A Case Study of Guangdong Province, China

Battery electric trucks (BETs) in port operations, drayage, and urban delivery reach total cost of ownership (TCO) parity with diesel before MY2025 in Guangdong, China—particularly 42-ton tractor-trailers. Fuel-cell trucks achieve parity later, around MY2028–2030. Comprehensive policy packages—tax exemptions, energy incentives, road access privileges, ...

**gpt-5.4-mini** (945 ms)
> Techno-Economic Feasibility Analysis of Zero-Emission Trucks in Urban and Regional Delivery Use Cases: A Case Study of Guangdong Province, China Battery electric trucks (BETs) in port operations, drayage, and urban delivery reach total cost of ownership (TCO) parity with diesel before MY2025 in Guangdong, China—particularly 42-ton tractor trailers. Fuel-cell trucks achieve parity later, around MY2028–2030. Comprehensive policy packages—tax exemptions, energy incentives, road access privileges, ...

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (2002 ms)
> The key findings are as follows: First, without policy incentives, regional delivery would see a modest ZET market share of 2–17 percent by MY2030, while ZET adoption would remain at a nascent stage for long-haul trucking through MY2035. Battery electric trucks will dominate regional delivery, but for long-haul application, the optimal technological mix is uncertain.

[{"box_2d": [78, 365, 480, 500, "label": "text", "caption": "In both applications, zero-emission tractor trailers are more likely to achieve a wide adoption than zero-emission straight trucks. This is primarily due to a wider cost gap between zero-emission straight trucks and their diesel counterparts, driven by greater payload losses in zero-emission straight trucks. Additionally, diesel straight trucks are generally more energy-efficient and have lower purchase costs than diesel tractor trailers."}]

In terms of technology selection, for regional delivery, battery electric trucks are more cost-competitive than fuel cell electric trucks and are expected to dominate this market segment. For long-haul trucking (particularly for tractor trailers), the optimal technological mix is uncertain.

**gpt-5.4-mini** (1324 ms)
> The key findings are as follows: First, without policy incentives, regional delivery would see a modest ZET market share of 2–17 percent by MY2030, while ZET adoption would remain at a nascent stage for long-haul trucking through MY2035. Battery electric trucks will dominate regional delivery, but for long-haul application, the optimal technological mix is uncertain.[{"box_2d": [78, 365, 480, 500, "label": "text", "caption": "In both applications, zero-emission tractor trailers are more likely to achieve a wide adoption than zero-emission straight trucks. This is primarily due to a wider cost gap between zero-emission straight trucks and their diesel counterparts, driven by greater payload losses in zero-emission straight trucks. Additionally, diesel straight trucks are generally more energy-efficient and have lower purchase costs than diesel tractor trailers."}] In terms of technology selection, for regional delivery, battery electric trucks are more cost-competitive than fuel cell electric trucks and are expected to dominate this market segment. For long-haul trucking (particularly for tractor trailers), the optimal technological mix is uncertain.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (2951 ms)
> It is assumed that diesel trucks retain about 30 percent of their retail price as residual value after first use (Pers. Comm. 2024; Basma et al. 2021). The above assumption likely underestimates ZET residual values (and their cost-competitiveness). Under the above assumption, ZET residual values account for 7–25 percent of their retail price, with particularly low residual values for longer-range BETs in the LH application, where larger battery capacity would typically result in higher resale value. To address this problem, we also developed several scenarios with increased ZET residual values to evaluate their impact on ZET adoption (see the subsection below “Scenario analysis and uncertainty analysis”). 28 | WRI.ORG.CN

# METHODS OF PROJECTING ZET PAYBACK PERIODS AND MARKET SHARE

The cumulative effect of the above decision variables is reflected in the projected ZET payback periods and TCO by application:

- ■ “Payback period” refers to the number of years required to recover the higher capital cost of a ZET compared to a diesel truck through ZETs’ operational cost savings. For the RD application, diesel trucks generally have a useful life of seven to 10 years (Pers. Comm. 2024; CATARC 2022). Thus, ZET adoption is deemed feasible when the payback period is within five years (Shenzhen Xieli 2022).

**gpt-5.4-mini** (1563 ms)
> Diesel trucks are assumed to retain about 30 percent of their retail price as residual value after first use (Pers. Comm. 2024; Basma et al. 2021). The above assumption likely underestimates ZET residual values (and their cost-competitiveness). Under the above assumption, ZET residual values account for 7–25 percent of their retail price, with particularly low residual values for longer-range BETs in the LH application, where larger battery capacity would typically result in higher resale value. To remedy this problem, we also developed several scenarios with increased ZET residual values to evaluate their impact on ZET adoption (see the subsection below “Scenario analysis and uncertainty analysis”). 28 | WRI.ORG.CN # METHODS OF PROJECTING ZET PAYBACK PERIODS AND MARKET SHARE The cumulative effect of the above decision variables is reflected in the projected ZETs' payback periods and TCO by application: - ■ “Payback period” refers to the number of years required to recover the higher capital cost of a ZET compared to a diesel truck through ZETs' operational cost savings. For the RD application, diesel trucks generally have a useful life of seven to 10 years (Pers. Comm. 2024; CATARC 2022). Thus, ZET adoption is deemed feasible when the payback period is within five years (Shenzhen Xieli 2022).

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (2481 ms)
> Notes: n = 6,902 Source: Survey results. 22 WRI.org.cn

For short and medium trips, compared with walking and buses (relying on fixed bus schedules), people prefer cycling, as it is time-saving. In most cities, motorized vehicles are overused for short-distance travel. For example, 39.3 percent of car trips are less than 5 kilometers in Beijing (BTI 2016). This means cycling has enormous potential for replacing motorized trips in cities.

Based on the survey results (shown in Table 3-1), depending on the city, 17–45 percent of total dockless bike-sharing kilometers traveled replaced motorized kilometers traveled (including private cars, taxis, ride-hailing, and motorcycles). Moreover, bike-and-ride (combined use of bicycle and public transport for one trip) may also have the potential to replace long-distance private motorized trips. And these impacts, especially in terms of replacing private vehicle travel, may be underestimated, as the questionnaire is designed to understand the trips finished by DBS, rather than the entire travel chain in this report.

Furthermore, according to the results, travelers prefer to use dockless bikes since they believe cycling provides opportunities for health gains, as an environmentally friendly travel mode.

**gpt-5.4-mini** (1316 ms)
> Notes: n = 6,902 Source: Survey results. 22 WRI.org.cn For short and medium trips, compared with walking and buses (relying on fixed bus schedules), people prefer cycling, as it is time-saving. In most cities, motorized vehicles are overused for short-distance travel. For example, 39.3 percent of car trips are less than 5 kilometers in Beijing (BTI 2016). This means cycling has enormous potential for replacing motorized trips in cities. Based on the survey results (shown in Table 3-1), depending on the city, 17–45 percent of total dockless bike-sharing kilometers traveled replaced motorized kilometers traveled (including private cars, taxis, ride-hailing, and motorcycles). Moreover, bike-and-ride (combined use of bicycle and public transport for one trip) may also have the potential to replace long-distance private motorized trips. And these impacts, especially in terms of replacing private vehicle travel, may be underestimated, as the questionnaire is designed to understand the trips finished by DBS, rather than the entire travel chain in this report. Furthermore, according to the results, travelers prefer to use dockless bikes since they believe cycling provides opportunities for health gains, as an environmentally friendly travel mode.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1457 ms)
> How Dockless Bike Sharing Changes Lives: An Analysis of Chinese Cities

Surveying 8,218 DBS users across 12 Chinese cities, DBS cycling yields a net annual mortality avoided of 59,635 among 235 million users. Cycling for up to one hour per day is optimal at PM2.5 levels of 50–60 µg/m³; cycling beyond 30 minutes is inadvisable above 160 µg/m³. DBS reduces CO₂ by 4.8 million tonnes annually. Some 54% of users connect DBS to other modes, with 91% linking to public transit. An estimated 15,556 annual bike fat...

**gpt-5.4-mini** (1028 ms)
> How Dockless Bike Sharing Changes Lives: An Analysis of Chinese Cities Surveying 8,218 DBS users across 12 Chinese cities, DBS cycling yields net annual mortality avoided of 59,635 among 235 million users. Cycling up to one hour daily is optimal at PM2.5 levels of 50–60µg/m³; cycling beyond 30 minutes is inadvisable above 160µg/m³. DBS reduces CO₂ by 4.8 million tonnes annually. Some 54% of users connect DBS to other modes, with 91% linking to public transit. An estimated 15,556 annual bike fat...

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (1427 ms)
> # How Dockless Bike-Sharing Changes Lives: An Analysis of Chinese Cities ## WRI.ORG.CN Report QR code: ## Authors Jiang Hui, Associate Researcher at the World Resources Institute (United States) Beijing Office Song Su, Researcher at the World Resources Institute (United States) Beijing Office Zou Xuan, Intern at the World Resources Institute (United States) Beijing Office Lu Lu, Associate Researcher at the World Resources Institute (United States) Beijing Office This report is supported by the Oak Foundation, the Stephen M. Ross Philanthropies, and the William and Flora Hewlett Foundation. ![img-4.jpeg](img-4.

**gpt-5.4-mini** (1149 ms)
> How Does Bike Sharing Affect Cities? ## HOW DOCKLESS BIKE-SHARING CHANGES LIVES: AN ANALYSIS OF CHINESE CITIES Jiang Hui, Song Su, Zou Xuan, Lu Lu WRI.ORG.CN Report QR code: ## Authors Jiang Hui, Associate Research Fellow, World Resources Institute (WRI) Beijing Representative Office Song Su, Research Fellow, World Resources Institute (WRI) Beijing Representative Office Zou Xuan, Intern, World Resources Institute (WRI) Beijing Representative Office Lu Lu, Associate Research Fellow, World Resources Institute (WRI) Beijing Representative Office This report was supported by Oak Foundation, Stephen M. Ross Philanthropies, and William and Flora Hewlett Foundation. ![img-4.jpeg](img-4.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (2329 ms)
> The emissions scope of the analysis covered all domestic transportation and distribution trips that originated or ended at Yantian Port, excluding international transloading and shipping and the emissions from port handling equipment. The emissions accounting method we used is a bottom-up activity-based method with data acquired through stakeholder interviews and a literature review. It should be noted that, due to insufficient data availability, we did not evaluate the cost-effectiveness of different optimization measures.

## Research findings and recommendations
The scenario construction revealed that shifting containers to railways and waterways would be so challenging for Yantian Port that it would be difficult for the port to reach the mode shift targets set in the Master Plan of Shenzhen Port (2035) without taking aggressive measures. Therefore, we constructed scenarios as follows in this study (Table ES-1):

(1). Enhanced-policy scenario (“Enhanced_policy”): This scenario assumed that Yantian Port will reach the freight mode shift targets outlined in the Master Plan of Shenzhen Port (2035) (TPRI 2018). By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution—together, the two modes will account for over 50 percent of the port throughput.

**gpt-5.4-mini** (1441 ms)
> The emissions scope of the analysis covered all the domestic transportation and distribution trips that originated or ended at Yantian Port, excluding international transloading and shipping and the emissions from port handling equipment. The emissions accounting method we used is a bottom-up activity-based method with data acquired through stakeholder interviews and a literature review. It should be noted that due to insufficient data availability, we did not evaluate the cost-effectiveness of different optimization measures. ## Research findings and recommendations The scenario construction revealed that shifting containers to railways and waterways would be so challenging for Yantian Port that it would be difficult for the port to reach the mode shift targets set in the *Master Plan of Shenzhen Port (2035)* without taking aggressive measures. Therefore, we constructed scenarios as follows in this study (Table ES-1): (1). Enhanced-policy scenario (“Enhanced_policy”): This scenario assumed that Yantian Port will reach the freight mode shift targets outlined in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018). By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution—together, the two modes will account for over 50 percent of the port throughput.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (2034 ms)
> By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution—together, the two modes will account for over 50 percent of the port throughput. Further, we assumed that battery-electric HDTs will represent 15 percent of fleet penetration by 2035. Since this assumption is conservative, we also analyzed the environmental benefits of having a 95 percent fleet penetration of battery-electric drayage trucks in 2035 in the same scenario. (2). Stated-policy scenario (“Stated_policy”): Because railway construction and expansion of the port’s catchment areas would take years, it would be challenging to shift containers to railways and waterways by 2025. Therefore, this scenario assumed that it is infeasible to reach the freight mode shift targets outlined in the Master Plan of Shenzhen Port (2035) (TPRI 2018) by 2025. Further, given that expansion of the port’s hinterland areas to make railways and waterways more cost-competitive (currently, Yantian Port mostly serves Guangdong Province) has future uncertainties, we assumed that the port will not reach the freight mode shift targets set in the Master Plan of Shenzhen Port (2035) by 2035. In the future, Yantian Port will still heavily depend on roadways for container transportation and distribution. (3).

**gpt-5.4-mini** (1777 ms)
> By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution—together, the two modes will account for over 50 percent of the port throughput. Further, we assumed that battery-electric HDTs will represent 15 percent of fleet penetration by 2035. Since this assumption is conservative, we also analyzed the environmental benefits of having a 95 percent fleet penetration of battery-electric drayage trucks in 2035 in the same scenario. (2). Stated-policy scenario (“Stated_policy”): Because railway construction and expansion of the port’s catchment areas would take years, it would be challenging to shift containers to railways and waterways by 2025. Therefore, this scenario assumed that it is infeasible to reach the freight mode shift targets outlined in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018) by 2025. Further, given that expansion of the port’s hinterland areas to make railways and waterways more cost-competitive (currently, Yantian Port mostly serves Guangdong Province) has future uncertainties, we assumed that the port will not reach the freight mode shift targets set in the *Master Plan of Shenzhen Port (2035)* by 2035. In the future, Yantian Port will still heavily depend on roadways for container transportation and distribution. (3).

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-5.4-nano · ✓ gpt-5.4-mini

**gpt-5.4-nano** (2180 ms)
> Reducing the remaining carbon emissions would require more aggressive measures such as a greater degree of freight mode shift and upstream decarbonization of grid emissions (see Figure ES-1). Second, although the optimization measures examined in this study have decarbonization potentials, not all measures have air pollution reduction co-benefits. Road-to-rail delivers the largest decarbonization and air pollutant reduction potential among the measures examined in this study. The promotion of battery-electric HDTs could also provide air pollution reduction co-benefits: Zero-emission HDTs representing 95 percent of the drayage truck fleet in 2035 would have the second-largest emission reduction potential, following road-to-rail (see Figure ES-2). 

Figure ES-1 | Well-to-wheel carbon dioxide emissions in the three policy scenarios  
Note: CO₂ = carbon dioxide.  
Source: Authors' calculations.  

Figure ES-2 | Reduction of well-to-wheel carbon dioxide emissions in the Enhanced_policy scenario with 95% battery electric drayage trucks in the fleet across different measures  
Note: WTW = well-to-wheel; CO₂ = carbon dioxide; HDT = heavy-duty truck; BAU = business as usual.  
Source: Authors' calculations.

**gpt-5.4-mini** (1413 ms)
> Reducing the remaining carbon emissions would require more aggressive measures such as greater degrees of freight mode shift and upstream decarbonization of grid emissions (see Figure ES-1). Second, although the optimization measures examined in this study have decarbonization potentials, not all measures have air pollution reduction co-benefits. Road-to-rail delivers the largest decarbonization and air pollutant reduction potential among the measures examined in this study. The promotion of battery-electric HDTs could also provide air pollution reduction co-benefits: Zero-emission HDTs representing 95 percent of the drayage truck fleet in 2035 would have the second-largest emission reduction potential, following road-to-rail (see Figure ES-2). Figure ES-1 | Well-to-wheel carbon dioxide emissions in the three policy scenarios Note: CO₂ = carbon dioxide. Source: Authors' calculations. Figure ES-2 | Reduction of well-to-wheel carbon dioxide emissions in Enhanced_policy scenario with 95% battery electric drayage trucks in the fleet by different measures Note: WTW = well-to-wheel; CO₂ = carbon dioxide; HDT = heavy-duty truck; BAU = business as usual. Source: Authors' calculations.
