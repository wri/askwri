# Route model sweep: routes-v1

- target: https://qa.askwri-app.org
- models: gpt-5.4-nano vs gpt-6-luna
- max_results: 40
- submodule commit: 1dcbeabc909073c4141e8088cce8b7fef6de243a
- evalset: evalset_answer_02.json
- evalset note: no expert_approved case in evalset_answer_02.json; the first 10 in file order were used
- code version: sha256:e308f1eeacf521992361fd14fc3c45a52d9894335c71c7878ca2c8052b57bb6f
- checks: 2 of 80 calls failed

No English control case: every case is non-English, so a regression that appears only on English input would not show here.

## Mechanical checks

Failed calls:
- batch-why / q6_bikeshare-co2-reduction / gpt-5.4-nano: response contains substituted text (provenance.sanitized), so part of it is not model output
- alignment / q6_bikeshare-co2-reduction / gpt-6-luna: response contains substituted text (provenance.sanitized), so part of it is not model output

## Acceptance numbers

### batch-why
- gpt-5.4-nano — calls 10, failed 1, p95 8618 ms (n=10), cost $0.012503
- gpt-6-luna — calls 10, failed 0, p95 10714 ms (n=10), cost $0.004503
- cost of gpt-6-luna vs gpt-5.4-nano: -64.0%

### batch-relates
- gpt-5.4-nano — calls 10, failed 0, p95 6036 ms (n=10), cost $0.010127
- gpt-6-luna — calls 10, failed 0, p95 6311 ms (n=10), cost $0.004377
- cost of gpt-6-luna vs gpt-5.4-nano: -56.8%

### alignment
- gpt-5.4-nano — calls 10, failed 0, p95 2357 ms (n=10), cost $0.004448
- gpt-6-luna — calls 10, failed 1, p95 5627 ms (n=10), cost $0.002758
- cost of gpt-6-luna vs gpt-5.4-nano: -38.0%

### translate
- gpt-5.4-nano — calls 10, failed 0, p95 2634 ms (n=10), cost unmeasured
- gpt-6-luna — calls 10, failed 0, p95 3168 ms (n=10), cost unmeasured

## batch-why

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2086 ms)
1. This passage directly reports the estimated penetration rate range for zero-emission heavy-duty trucks in China through future model years, including a specific statement about penetration by 2030 under a no-policy scenario (and the study spans to 2035). This is the closest explicit market-penetration data relevant to the query’s “through 2035” timeframe.
2. This passage provides technical definitions and context for modeling variables (e.g., annual vehicle kilometers traveled) used in assessing adoption and penetration of battery electric trucks. While it does not state a penetration rate itself, it supports understanding how the projected penetration is calculated.
3. This passage discusses WRI projections and strategy options for China’s road transport sector but does not provide the projected market penetration rate for new energy heavy-duty trucks through 2035. It is relevant only as contextual background on decarbonization projections and measures.

**gpt-6-luna** (2978 ms)
1. This passage directly addresses zero-emission heavy-duty truck adoption in China through 2035 and reports projected penetration rates for regional and long-haul freight scenarios, including figures for 2030 under a no-policy scenario. The excerpt does not show the full 2035 projections, but it identifies the relevant forecast.
2. This passage lists technical assumptions such as annual vehicle kilometers traveled and charging terminology, which may inform the modeling behind heavy-duty truck projections but does not state market penetration rates.
3. This passage discusses broader strategies for decarbonizing China’s road transport sector, providing related policy context but no specific heavy-duty truck penetration projection through 2035.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (7008 ms)
1. This case study directly analyzes techno-economic feasibility of zero-emission battery-electric trucks in China, which typically includes cost comparisons relevant to total cost of ownership versus diesel in practice.
2. The passage points to a study on evaluating electric vehicle costs and benefits in China, which can provide cost inputs (and comparisons) needed to estimate TCO differences between electric and diesel heavy-duty trucks.
3. It explicitly cites a work focused on total cost of ownership for heavy trucks in China comparing battery-electric, fuel cell electric, and diesel trucks—exactly the comparison the query asks for.
4. This passage is from a policy-focused report on accelerating zero-emission heavy-duty truck adoption in China; such reports often discuss cost and feasibility considerations that inform TCO comparisons even if not fully enumerated here.
5. Like Passage 4, this is from the same policy/report context and relates to modeling and market behavior that can affect adoption economics and therefore TCO comparisons between ZETs and diesel.
6. This passage discusses barriers and challenges for BEVs and hydrogen fuel cell vehicles in commercialization, which can influence the real-world costs and costs drivers that would be reflected in TCO relative to diesel.
7. It references carbon-neutrality pathway comparisons for China’s road transport, which may include cost or scenario assumptions affecting relative economic performance of electrified options versus diesel, including heavy-duty.
8. This Shenzhen port logistics study is about transportation and distribution systems and could include cost/emissions implications for freight modes, but it is not specifically about comparing battery-electric vs diesel heavy-duty truck TCO.
9. This provides a vehicle fleet model documentation for Guangdong, useful for estimating vehicle stock, usage, emissions, and energy use—key inputs to TCO modeling—though it does not directly report the TCO comparison results.
10. It explicitly states that pure electric heavy trucks can reach TCO parity with traditional fuel trucks under ideal 1:1 replacement, and it presents a figure comparing total owning cost components (purchase, taxes, operating, maintenance, insurance, roads) across heavy truck types.
11. This passage defines TCO and includes an explicit table comparing technologies (with sources/author calculations) in the context of feasibility analysis, which would support a battery-electric vs diesel heavy-duty TCO comparison.
12. It contains a table listing BEV and FCEV options by vehicle duty class (including heavy-duty), which can support constructing or interpreting TCO comparisons, but it does not itself provide the cost comparison outcome in the excerpt.
13. Although focused on transit buses, this passage describes a tool that compares diesel and battery electric options across fleets, offering methodological relevance for how to compute TCO differences (even if not heavy-duty trucks).
14. It references prior studies showing electrics (e.g., e-buses) can be cheaper overall than diesel counterparts, providing background on typical TCO directionality that could motivate expectations for heavy-duty trucks, though not China truck-specific.
15. This passage discusses a TCO analysis framework and long-term battery degradation impacts for e-buses, which is relevant to how TCO comparisons between electric and diesel trucks should account for lifecycle costs, even if it is not heavy-duty.
16. It is a methodology guide for transport emissions and social cost assessment, which may support TCO-like welfare calculations or cost components, but it does not directly compare battery-electric vs diesel heavy-duty truck ownership costs.
17. It explicitly links electric bus adoption to reduced cost of ownership versus emissions, indicating that TCO is a core metric in such comparisons, though again it is bus-specific rather than China heavy-duty trucks.
18. This is about electrifying school buses in the US and focuses on policy scenarios rather than China heavy-duty truck TCO comparisons, so it offers limited relevance to the specific query.
19. This tool is explicitly designed to compare a zero-emission truck (ZET) and an internal combustion (diesel/ICE) truck across financial metrics like payback—directly aligned with comparing economic feasibility and TCO-related outcomes, though it is stated for India.
20. It provides an explanation/definition of TCO for auto-rickshaws rather than heavy-duty trucks in China; it can be methodologically relevant but does not answer the battery-electric vs diesel heavy-duty truck TCO comparison.

**gpt-6-luna** (10714 ms)
1. This Guangdong study analyzes the techno-economic feasibility of battery-electric trucks in China and may compare their costs with diesel trucks across delivery use cases. The excerpt is truncated, so it does not reveal the specific TCO results.
2. This passage is a bibliography entry about China’s road-transport decarbonization and electric-vehicle costs, but it does not provide a heavy-truck TCO comparison.
3. It identifies a study specifically comparing the total cost of ownership of battery-electric, fuel-cell, and diesel heavy trucks in China. It is directly pertinent, though the excerpt gives no findings or figures.
4. This passage lists references on truck markets and related topics, but the excerpt does not provide a China-specific comparison of battery-electric and diesel truck ownership costs.
5. The excerpt is a list of references about vehicle markets and consumer choice, rather than evidence about the TCO of battery-electric versus diesel heavy-duty trucks in China.
6. It discusses barriers to adopting battery-electric and fuel-cell vehicles in China and other countries, offering context on technology uptake but no heavy-truck TCO comparison.
7. This passage cites research on China’s low-carbon transition pathways, which provides broad transport-decarbonization context but no direct comparison of electric and diesel truck TCO.
8. The study concerns transport systems serving a Shenzhen port and evaluates rail, water, and road options, but the excerpt does not address battery-electric versus diesel truck ownership costs.
9. This source describes a model for estimating China’s vehicle fleets, use, emissions, and energy consumption; it may provide background inputs, but the excerpt does not report truck TCO comparisons.
10. It explicitly compares the TCO of several types of battery-electric heavy trucks with diesel trucks in Beijing and says some electric models can reach cost parity under ideal one-for-one replacement. It directly addresses the query, although the excerpt omits the chart’s numerical results.
11. The passage defines terms for a heavy-duty truck TCO comparison, but the excerpt does not show the comparison results or clarify the technologies and scenarios involved.
12. This passage concerns road-transport decarbonization in Hong Kong and includes heavy-duty vehicle technology categories, but it does not compare truck ownership costs in China.
13. The tool compares costs for transit buses, including battery-electric and diesel options in China, but bus economics do not directly answer the question about heavy-duty trucks.
14. It summarizes TCO findings for electric buses compared with diesel buses in other markets, not heavy-duty trucks in China, so it offers only general context on electrification costs.
15. This passage discusses methods and studies for assessing electric-bus TCO and battery degradation, but it does not address heavy-duty truck costs or China specifically.
16. The excerpt presents transport-cost data without a clear connection to Chinese heavy-duty trucks or a battery-electric versus diesel TCO comparison.
17. It describes electric-bus ownership and operating-cost benefits in a city outside China, providing general context but not the requested truck comparison.
18. This passage concerns policies for electrifying U.S. school buses and does not provide evidence about heavy-duty truck TCO in China.
19. The tool compares zero-emission and diesel trucks, but it is designed for Indian operators and the excerpt does not provide results for China or specifically quantify the requested comparison.
20. This passage explains TCO for electric auto-rickshaws in Indian cities, a different vehicle class and country, so it offers only general background on ownership-cost analysis.

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (4661 ms)
1. This passage provides a direct comparison of zero-emission truck (ZET) market share/adoption outcomes for regional delivery versus another freight mode within the article’s regional and long-haul framing. It quantifies adoption potential in the regional case (2–17% by 2030) and describes how policy incentives affect the gap to long-haul adoption.
2. This passage discusses a key sensitivity assumption (Residual_value_30%) used in the techno-economic/policy modeling within the same regional vs long-haul study. While it does not by itself state the adoption differences, it underpins how the scenario results for regional and long-haul potential are tested.
3. This passage explains factors limiting heavy-duty truck adoption of zero-emission options, including lack of policy incentives and delayed TCO parity. These constraints are relevant background for why regional transport scenarios may differ in adoption potential from long-haul scenarios.
4. This passage focuses on emission breakdown across modes under different policy scenarios, which supports understanding how regional vs long-haul activity translates into modeled outcomes. However, it does not explicitly quantify ZET adoption potential differences, making it only indirectly related to the adoption potential question.
5. This passage explicitly addresses how implementing zero-emission freight zones (ZEFZs) impacts long-haul versus regional-haul transport and goods supply. It is therefore directly relevant to comparing adoption potential between regional and long-haul scenarios under ZEFZ-related policies.
6. This passage discusses differential feasibility/adoption considerations for urban delivery versus longer-mile and cold-chain operations, mapping closely onto the regional vs long-haul distinction. It directly indicates that BEVs can work well for most city light delivery (regional) but face challenges at long distances (long-haul).
7. This passage provides methodological sourcing (personal communications) for a feasibility analysis, rather than reporting adoption potential differences between regional and long-haul scenarios. It is relevant only as supporting evidence for the modeling assumptions.
8. Similar to the previous one, this passage is additional documentation of interview/communication sources used in the feasibility analysis. It does not itself compare adoption potential, but it underlies the study that includes regional delivery use cases.
9. This passage describes limitations of a financial assessment tool, including sensitivity to user-defined financial assumptions. It is relevant background for interpreting scenario-based adoption potential differences, though it does not directly compare regional vs long-haul adoption levels.

**gpt-6-luna** (5235 ms)
1. This passage directly compares zero-emission truck adoption prospects in regional delivery and long-haul freight, including the regional market-share estimate and the relatively nascent long-haul outlook.
2. It describes an assumed residual-value guarantee used in sensitivity analysis, a financial condition that could affect adoption potential, but it does not itself compare regional and long-haul scenarios.
3. It gives background on barriers to zero-emission heavy-duty truck adoption, including technology constraints, industry fragmentation, delayed cost parity, and limited incentives. It does not distinguish regional from long-haul potential.
4. It concerns road-transport emissions under different policy scenarios, which provides broader decarbonization context but does not directly compare zero-emission truck adoption in regional and long-haul transport.
5. It addresses how zero-emission freight zones could affect both long-haul and regional-haul transport, making it relevant to the two freight contexts, though it does not quantify their adoption potential.
6. It discusses which urban truck applications are suitable for zero-emission vehicles and notes challenges for longer-distance and cold-chain uses. This offers related context on how operating conditions affect adoption, but it is not a regional-versus-long-haul comparison.
7. This is a reference-list fragment from a study of urban and regional delivery feasibility; it identifies the study's topic but provides no findings about adoption potential or a long-haul comparison.
8. This is another reference-list fragment from the urban and regional delivery feasibility study and supplies no substantive comparison of adoption potential with long-haul transport.
9. It describes financial-assumption limitations in a truck-feasibility tool, which may matter when assessing adoption economics but does not compare regional and long-haul scenarios.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (5100 ms)
1. This passage provides assumptions about diesel truck residual value, which directly affects comparative lifetime economics and thus the payback period comparison versus battery electric trucks.
2. It focuses on techno-economic feasibility of battery electric trucks (BETs) in China (e.g., port operations), which is the type of analysis that can be used to derive payback periods relative to diesel. 
3. It includes an explicit residual value assumption for zero-emission trucks used in sensitivity analysis, which is a key input into cashflow and payback period calculations compared with diesel.
4. This passage states when BETs reach TCO parity relative to ICEV (diesel) counterparts, and TCO parity timing is closely related to (and often used as a proxy for) payback timing.
5. It defines “payback period” as the time needed to break even on an investment, establishing the conceptual metric the question asks for in China comparisons.
6. This is a bibliographic citation about evaluating electric vehicle costs and benefits in China, which likely contains supporting data needed for payback-period analyses.
7. This cited white paper is explicitly about total cost of ownership for heavy trucks in China across battery electric, fuel cell electric, and diesel, which is the economic basis for deriving or comparing payback periods.
8. It provides quantified cost differences between pure electric freight trucks and conventional fuel trucks (including distance thresholds where parity may occur), which can inform payback or break-even timing.
9. It discusses constraints and current emphasis of the electric truck market in China (e.g., battery capability for heavy-duty power demands), which affects which routes/segments get analyzed for economics like payback periods.
10. This citation relates to modeling the vehicle fleet and usage in China, which can provide inputs (mileage, utilization) required to compute payback periods for BEVs vs diesel.
11. This cited work directly compares TCO for heavy trucks in China across battery electric, fuel cell, and diesel, which is closely tied to payback-period comparisons.
12. It describes diesel-based port freight transport and the context for decarbonization, but it does not directly provide payback-period calculations; still, it frames where BEVs vs diesel are being considered.
13. It explicitly links accelerated adoption to reaching TCO parity with diesel, which provides timing information that can correspond to payback/break-even periods for battery electric (and hydrogen) HGVs.

**gpt-6-luna** (7331 ms)
1. This passage discusses residual-value assumptions for diesel and zero-emission trucks, which can affect their comparative economics and payback calculations, but the excerpt does not give payback periods.
2. This Guangdong study compares battery-electric and conventional trucks in Chinese delivery use cases, providing relevant economic context, but the excerpt does not state semi-truck payback periods.
3. The passage describes a residual-value sensitivity assumption for zero-emission trucks, a factor in truck cost and payback analysis, but it does not report payback periods.
4. It reports cost advantages and timing of total-cost-of-ownership parity for battery-electric trucks in several Guangdong use cases, which is related to—but not the same as—their payback period versus diesel.
5. This passage defines payback period as an investment-recovery metric and identifies it as an output of truck comparisons, but it provides no China-specific semi-truck figures.
6. This is a reference-list excerpt about vehicle statistics and electric-vehicle costs in China, offering background but no semi-truck payback estimates.
7. It cites a study comparing battery-electric, fuel-cell, and diesel heavy trucks in China, a potentially relevant source for the requested comparison, but gives no payback-period results itself.
8. The excerpt gives cost differences and distance-related figures for electric trucks, including a 49-ton semi-truck, compared with conventional fuel trucks in Beijing; these figures are relevant to economic recovery but are not clearly stated as payback periods.
9. It provides background on the limitations and development of electric heavy trucks in China, but does not compare their payback periods with diesel trucks.
10. This reference-list material concerns a China road-transport model and supplies no specific battery-electric versus diesel semi-truck payback figures.
11. It cites a study on total ownership costs for heavy trucks in China, including battery-electric and diesel models, which is relevant background but does not state payback periods.
12. The passage describes diesel-truck use in Chinese container ports and the broader low-carbon transport context, but provides no comparative payback-period data.
13. It links zero-emission heavy-goods vehicles' adoption to reaching total-cost parity with diesel, which is related to comparative economics but does not provide payback periods or China-specific semi-truck figures.

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (7735 ms)
1. This passage reports survey findings on dockless bike-sharing in China, including the share of trips that replace other motorized trips (it explicitly discusses replacing short-distance motor vehicle trips). It directly contains the information needed to estimate what portion of bike-share trips come from car/taxi/ride-hailing substitution.
2. This passage is about decarbonization strategies for China’s road transport sector and focuses on emissions/energy consumption by mode. It does not provide the specific trip-replacement shares for bike-share versus private car/taxi/ride-hailing.
3. This passage states that bike-sharing is used for connecting to other transport and includes figures about the percentage of trips that substitute private car trips for short trips (the text is truncated but clearly about substitution). It directly addresses the question about replacement of private car/taxi/ride-hailing trips, though taxi/ride-hailing may be less explicit.
4. This passage provides general modal share targets/achievements for commute trips in other cities/countries (e.g., Santiago) and does not focus on China or bike-share trip substitution.
5. This passage gives factual context about the scale of bicycle-sharing systems in China (e.g., Hangzhou fleet size). It does not quantify what share of trips replace private car/taxi/ride-hailing.
6. This passage describes the emergence and growth of dockless bike-sharing technology in China, including fleet adoption. It does not provide trip-replacement percentages against private car/taxi/ride-hailing.
7. This passage discusses China’s broader transport and emissions targets (e.g., rail and bus ridership growth), not bike-share substitution of private car/taxi/ride-hailing trips.
8. This passage is about another topic (e.g., living conditions in Johannesburg) and does not provide China bike-share modal substitution data.
9. This passage is about electrifying ride-hailing in the US/EU/Canada, focusing on whether ride-hailing replaces or adds to private vehicle travel. It does not provide China bike-share replacement shares.
10. This passage focuses on Hong Kong’s road transport emissions and net-zero pathways. It does not answer the question about what share of China bike-share trips replace private car/taxi/ride-hailing trips.
11. This passage discusses bicycle use as a “last-mile” mode and includes data on walking/cycling shares connecting to public transit in various Chinese cities. It provides related context but not the specific share of bike-share trips that substitute private car/taxi/ride-hailing.
12. This is a methodology guide for transport emissions/social cost and includes tables for private car emissions categories. It does not provide bike-share trip substitution shares.
13. This passage discusses ride-hailing users substituting modes in general (competition between modes) but does not provide China bike-share replacement statistics.
14. This passage covers lessons from implementing public bicycle sharing in India, not China or substitution of private car/taxi/ride-hailing trips.
15. This passage is a guide for assessing environmental impacts of shared micromobility and explains what cities should evaluate. It does not contain the specific empirical share for China bike-share replacing car/taxi/ride-hailing.
16. This passage provides conceptual discussion about environmental impacts depending on whether shared services replace or add trips. It does not give China-specific quantitative replacement shares.
17. This passage provides broad global context on shared mobility services and their growth, not China-specific evidence on replacement of private car/taxi/ride-hailing by bike-share trips.
18. This passage is about upgrading informal settlements (Surabaya) and does not concern bike-sharing trip substitution in China.
19. This passage describes demand responsive transit/ride-hailing business models and does not provide China bike-share substitution shares.
20. This passage provides grid-impact modelling for electric vehicles in China, including some taxi adoption figures. It is not about bike-share trip replacement of private car/taxi/ride-hailing trips.
21. This passage is an overview of public transportation reforms in Latin America and includes unrelated table values. It does not address China bike-share trip substitution.
22. This passage gives background on the prevalence of bike-sharing in China (number of cities offering services) and vehicle ownership trends. It does not provide the specific percentage of bike-share trips that replace private car/taxi/ride-hailing.
23. This passage is about public space interventions in Guadalajara and shows mode split for trip purposes, not bike-share substitution in China.
24. This passage discusses behavioral choice for commuting to metro rail in Bengaluru and does not include China bike-share replacement shares.
25. This passage focuses on bus aggregators in India and provides modelling details for private car trip costs. It does not provide bike-share substitution data for China.
26. This passage discusses feasible interventions for Mexico’s transport sector, including encouraging more public transport/cycling to reduce vehicle trips. It does not provide China bike-share empirical trip replacement shares.

**gpt-6-luna** (9773 ms)
1. This passage appears to report survey results on how dockless bike sharing changes travel choices in Chinese cities, which may include the share of trips replacing motorized modes. The excerpt is truncated before giving the figures.
2. It discusses emissions and energy use across transport modes in China, but the excerpt does not address which trips bike sharing replaces or provide a substitution share.
3. It directly reports that 17%–45% of bike-share trips replaced private motorized trips, addressing the requested share. The excerpt is cut off before specifying the full mode breakdown.
4. This passage concerns walking and cycling targets in Vietnamese cities, not the share of Chinese bike-share trips replacing car, taxi, or ride-hailing trips.
5. It gives background on the scale of bicycle sharing in China but does not say what share of trips substitute for private cars, taxis, or ride-hailing.
6. It describes the rapid growth and rollout of dockless bike sharing in China, providing context but no trip-substitution percentage.
7. It provides context about public transport use and policy in China, but it does not quantify bike-share trips replacing motorized private or for-hire trips.
8. This passage concerns travel patterns in Johannesburg rather than bike-share trip substitution in China, so it does not answer the query.
9. It discusses how ride-hailing affects emissions depending on what trips it replaces, but does not provide a Chinese bike-share substitution share.
10. This passage concerns transport emissions in Hong Kong and does not address bike sharing or the share of trips replacing cars, taxis, or ride-hailing.
11. It discusses bicycle access to public transportation in China, which is related to bike travel but not to the requested share of trips replacing private motorized modes.
12. It lists transport categories for an emissions assessment methodology but provides no evidence about Chinese bike-share trips or their replacements.
13. It describes ride-hailing as a substitute mode in other contexts, but does not quantify bike-share trips replacing ride-hailing or other motorized modes in China.
14. It concerns public bicycle-sharing implementation in Indian cities, not the replacement share for bike-share trips in China.
15. It explains how cities can assess micromobility’s emissions effects, which is related to trip substitution, but gives no China-specific share.
16. It discusses the emissions implications of shared mobility trips replacing other modes, but does not report the requested Chinese bike-share percentage.
17. It provides general context on the growth of shared mobility, including bike sharing, but does not quantify which modes bike-share trips replace in China.
18. This passage concerns transport and settlement conditions in Surabaya and does not address Chinese bike-share trip substitution.
19. It explains how ride-hailing services operate, but does not provide information about bike sharing or its mode-replacement share in China.
20. It concerns projections for electric vehicles and taxis in China, not bike-share trips or the share replacing taxis, cars, or ride-hailing.
21. It reports on motorcycle- and bike-taxi services in Latin America rather than Chinese bicycle sharing and its trip substitutions.
22. It notes the spread of shared bikes and growth in private car ownership in China, offering relevant background but no estimate of bike-share trips replacing motorized modes.
23. It gives transport-mode shares in Guadalajara, Mexico, rather than the replacement share for bike-share trips in China.
24. It discusses commuter mode choices in Bengaluru, India, without addressing Chinese bike-share trip substitution.
25. It discusses trip-cost assumptions for cars in India, not how bike-share trips in China replace car, taxi, or ride-hailing journeys.
26. It concerns transport strategies in Mexico and mentions cycling generally, but does not provide the requested China-specific substitution share.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✗ gpt-5.4-nano — response contains substituted text (provenance.sanitized), so part of it is not model output · ✓ gpt-6-luna

**gpt-5.4-nano** (6163 ms) — sanitized: some text was substituted
1. This passage is an analysis of dockless bike-sharing in Chinese cities and includes study outputs derived from survey data. It is likely to contain the emissions reduction attribution estimates the query asks for.
2. This passage provides relevant context for the query.
3. This passage is about decarbonizing China’s road transport sector and modeling inputs/outputs, but it does not specifically quantify CO2 reductions attributed to bike-sharing. It provides sector context rather than the bike-sharing attribution number.
4. This passage describes bicycle-sharing examples and mentions that China has the world’s largest systems, but it does not provide CO2 emissions reduction attributed to bike-sharing. It is relevant only for background on the scale of bike-sharing.
5. This passage gives specific operational details about China’s bicycle share systems (e.g., Hangzhou stations and bicycles). It does not state CO2 emissions reduction attributed to bike-sharing, but it may support understanding of how large the system is for any emissions calculations.
6. This passage discusses general climate mitigation modeling outcomes for countries/regions and includes percentage reductions, but it does not focus on bike-sharing or attribute CO2 reductions to it. Therefore it does not directly answer the query.
7. This passage focuses on transport CO2 accounting methodologies and notes historical trends for Beijing and Shenzhen. It does not quantify the CO2 reduction attributable to bike-sharing, so it is only method/background related.
8. This passage is about the evolution of bike-sharing technology (e.g., smart cards) and interoperability with public transit payments. It does not provide emissions reduction attribution, so it is not directly relevant to the CO2 reduction amount.
9. This passage provides emissions shares for motor vehicles and other pollutants in Beijing, which is not bike-sharing-specific and does not provide a CO2 reduction attribution for bike-sharing. It is therefore only indirectly related to transport emissions context.
10. This passage discusses projections of China’s transport emissions peaking and links to climate goals, but it does not mention bike-sharing or provide an attribution of CO2 reductions to it. It is broader transport decarbonization context.
11. This passage is about emissions accounting approaches (production vs. consumption) for shared micromobility. While not giving a specific CO2 reduction figure for China bike-sharing, it is relevant because the attribution depends on the accounting framework.
12. This passage describes scenario/optimization logic for transport decarbonization and does not mention bike-sharing or China-specific CO2 reduction attribution. It is not directly responsive to the query.
13. This passage describes how CO2 emissions are calculated for bike sharing (comparing trips that could have been made by car) in an India context. It is relevant only for methodology understanding, not for the specific question about how much CO2 reduction is attributed to bike-sharing in China.
14. This passage provides energy/emissions background about China’s overall CO2 situation (e.g., coal share) but does not discuss bike-sharing or its attributable CO2 reductions. It is not directly related to the query.
15. This passage is about feasibility of zero-emission trucks and case study activities, not bike-sharing. It does not contain information on CO2 reduction attributed to bike-sharing in China.

**gpt-6-luna** (6553 ms)
1. This study evaluates dockless bike-sharing in Chinese cities and mentions emissions benefits, but the excerpt gives no specific CO₂ reduction figure.
2. This passage describes a China-focused study that estimates bike-sharing’s emissions reductions, directly matching the query, though the excerpt omits the numerical result.
3. It concerns emissions accounting for China’s road-transport modes, but does not discuss bike-sharing or give its attributed CO₂ reduction.
4. It provides context on the scale of bike-sharing in China, including Hangzhou’s system, but says nothing about CO₂ reductions.
5. It notes that China has the world’s largest bike-sharing systems and gives Hangzhou system statistics, but does not quantify emissions reductions.
6. It reports modeled emissions reductions for countries including China, but the figure is not specifically attributed to bike-sharing.
7. It gives background on rising transport CO₂ emissions in Chinese cities, but does not address bike-sharing’s reduction impact.
8. It describes bike-sharing integration with public transport in Chinese cities, which is relevant context for potential emissions effects, but gives no reduction estimate.
9. It discusses motor-vehicle pollution in Beijing, but does not connect those emissions to bike-sharing or quantify a reduction from it.
10. It provides context on China’s transport decarbonization needs, but does not identify bike-sharing’s contribution or a specific reduction amount.
11. It explains methods for assessing shared micromobility emissions, which can inform how reductions are calculated, but gives no China-specific result.
12. It concerns transport decarbonization strategies in India rather than bike-sharing emissions reductions in China.
13. It explains a method for calculating CO₂ savings from public bicycle sharing, but the discussion is about Indian cities, not the reduction attributed to bike-sharing in China.
14. It provides broad context on China’s energy-related CO₂ emissions, but does not discuss bike-sharing or its emissions reductions.
15. It concerns zero-emission trucks in Guangdong rather than bike-sharing, so it does not answer the query.

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (7565 ms)
1. This passage introduces dockless bike-sharing (DBS) as a widely adopted shared transport system and frames it as having an impact on people’s lives. It is directly relevant because the query asks about how DBS affects travel behavior in Chinese cities.
2. This is the report’s title/identification for a study specifically about how dockless bike-sharing affects cities in China. It is directly relevant because it signals the source material that analyzes DBS impacts on urban travel behavior.
3. This passage provides historical context on the emergence and rapid growth of dockless bike sharing in China, including the scale by 2017. Such rollout information is relevant to understanding how and why travel behavior could change as adoption expands.
4. This passage gives concrete scale details for bicycle sharing in China (e.g., Hangzhou station and bike counts). System size and availability are important drivers of how users may adjust trips and mode choices, linking to travel behavior effects.
5. This passage compares large bicycle-sharing deployments and again emphasizes China’s leading scale (e.g., Hangzhou). By establishing widespread presence, it indirectly supports discussion of behavioral changes such as increased cycling trips or altered commuting patterns.
6. This passage focuses on decarbonization strategies and emissions modeling for road transport rather than directly describing behavioral changes from DBS. It is only indirectly relevant to the extent that travel behavior shifts can be inferred through emissions outcomes.
7. This passage is a bibliography snippet related to public transport access and includes a citation about dockless bike-sharing. While it does not explain effects itself, it may point to studies addressing how shared bikes relate to travel patterns and planning considerations.
8. This passage notes the growing popularity of shared bikes across many Chinese cities and provides broader context on competing trends like car ownership growth. That context is relevant to interpreting how DBS may influence travel behavior relative to automobile use.
9. This methodology guide is about transport emissions and social cost assessment, not travel behavior itself. It is relevant only indirectly because emissions modeling often depends on assumptions about mode shares and trip patterns.
10. This passage is a guide for assessing environmental impacts of shared micromobility services and discusses evaluation frameworks (including LCA). It is not primarily about behavior, but it can indirectly inform how DBS might be studied in terms of outcomes driven by travel changes.
11. This passage is primarily about global EV and CO2 data sources and is not focused on dockless bike-sharing or Chinese urban travel behavior. It has little direct connection to how DBS changes mode choice or trip patterns.
12. This passage discusses first-mile and last-mile transportation patterns in the context of mobility and shared schemes. That is relevant to travel behavior because it relates to how users combine modes and may shift short-trip behavior when DBS is available.
13. This passage describes emerging solutions in shared mobility (including ride-hailing) and includes a figure on characteristics of new mobility schemes. While not specific to Chinese DBS behavior, it provides background on how new mobility services can affect travel behavior.
14. This passage explains dockless bike-sharing/technology’s role in reducing the need for parking infrastructure. That directly relates to travel behavior insofar as convenience and accessibility changes how people choose trips and pick-up/drop-off patterns.
15. This passage emphasizes embedding considerations of existing mode shares and the role they play in encouraging sustainable mobility. That is directly relevant to travel behavior because DBS effects depend on whether it shifts people from other modes or complements them.
16. This passage focuses on bicycle lane design and safety during and after COVID, including dedicating resources/space to walking and cycling. It is relevant indirectly because safety infrastructure can influence cycling uptake and thus how DBS users adjust their travel behavior.
17. This passage is about assessing climate policy coverage and includes an example of regulating traffic flows via smart transportation systems. It is only indirectly connected to DBS travel behavior, since policy and traffic management affect mode choices and route decisions.

**gpt-6-luna** (8177 ms)
1. This passage introduces a report specifically about how dockless bike-sharing affects people's lives in Chinese cities, making it directly relevant to its effects on travel behavior.
2. This is the title and author information for a report analyzing how dockless bike-sharing changes life in Chinese cities. It identifies a likely source for evidence about resulting travel-behavior changes.
3. It describes the emergence and rapid growth of dockless bike-sharing in China, providing context for how widespread the service became and its potential to influence travel behavior.
4. It gives the scale of a major Chinese bicycle-sharing system, but discusses station-based sharing rather than dockless services or their effects on travel behavior.
5. It provides figures on the size of Hangzhou's station-based bike-sharing system, offering background on bicycle sharing in China but not explaining dockless systems' behavioral effects.
6. The passage concerns transport-sector energy and emissions data, but does not address dockless bike-sharing or changes in how people travel.
7. This passage cites a 2017 white paper on shared bicycles and urban development, which may provide background on bike-sharing in China, but the excerpt does not state its findings about travel behavior.
8. It notes the spread of shared-bike services across Chinese cities alongside rising car ownership, providing context for how bike-sharing fits into broader travel patterns, but does not describe its behavioral effects.
9. This passage concerns assumptions in a transport-emissions assessment tool and does not discuss bike-sharing or travel behavior in Chinese cities.
10. It concerns environmental assessment of shared micromobility, which may include shared bikes, but the excerpt focuses on life-cycle assessment rather than changes in travel behavior.
11. This is a reference list about electric mobility and emissions, with no specific information about dockless bike-sharing or its influence on travel choices.
12. The passage mentions first- and last-mile transportation patterns, a travel behavior that dockless bikes can affect, but it does not specifically discuss bike-sharing in China.
13. It provides general background on shared mobility and emerging transport schemes, but the excerpt does not address dockless bikes or Chinese travel behavior.
14. It explains how dockless bike-sharing was introduced in an Indian city, which offers a comparison for the technology but does not answer how it affects travel behavior in China.
15. It discusses how cycling schemes can support sustainable mobility and the importance of considering mode shares, providing related context but not evidence about dockless bike-sharing in China.
16. It addresses the need to support safe walking and cycling, which is relevant to cycling as a travel mode, but does not discuss dockless bike-sharing or its behavioral effects.
17. The passage concerns local climate policies and smart traffic management, not dockless bike-sharing or changes in urban travel behavior.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (4012 ms)
1. This passage frames an analysis focused on Yantian Port’s domestic transportation and distribution emissions, which is directly tied to how freight mode shifts would translate into decarbonization outcomes. It helps assess whether Yantian’s hinterland logistics can plausibly change modes to meet Shenzhen’s 2035 targets.
2. This passage discusses how the effectiveness of decarbonization measures varies by region and highlights near-term options like zero-emission vehicles. That is relevant because meeting mode-shift targets often depends on choosing measures with sufficient regional abatement potential, informing whether a stated trajectory may be insufficient.
3. This passage defines a “Stated Policy” scenario and contrasts it with other scenarios (e.g., structural change). Since the query asks whether targets require more aggressive measures than a stated-policy trajectory, this provides the needed baseline concept for comparison.
4. This passage describes how, in high-density cities, trends can reverse passenger mode shift toward private cars. While the query is about freight/mode shift for port logistics, the discussion provides contextual evidence on how difficult it can be for mode shift targets to materialize without stronger interventions.
5. This passage details policy mechanisms for shifting urban travel from energy-intensive modes to cleaner modes using a “pull and push” strategy, including public transport coverage and reducing car dependence. These policy levers are directly relevant to evaluating whether Shenzhen’s port-adjacent logistics would need more than a stated-policy trajectory to achieve its mode-shift goals.
6. This passage evaluates local government low-carbon strategies through the lens of climate policy coverage, including the presence of sustainable transportation plans and emission reduction targets. That directly informs whether Shenzhen (and by extension Yantian’s connected systems) has sufficiently strong policy coverage to realistically meet 2035 mode-shift targets beyond a stated-policy path.

**gpt-6-luna** (5020 ms)
1. This case study focuses specifically on Yantian Port’s transport and distribution system, making it directly relevant to assessing its mode-shift prospects. The excerpt only identifies the study’s emissions scope, however, and does not provide the targets or results needed to judge whether the port can meet them.
2. This passage discusses how effective different decarbonization measures can be across regions, which can inform whether ordinary policy measures are sufficient or stronger interventions are needed. It does not establish Yantian-specific mode-shift projections.
3. It defines the Stated Policy scenario and distinguishes it from a Structural Change scenario, directly relevant to comparing a policy-as-usual trajectory with more transformative action. The excerpt does not give Yantian-specific outcomes or compare them with Shenzhen’s 2035 targets.
4. It provides broader context on how urban conditions can shape travel-mode shifts, including the risk of movement toward private cars. This may inform expectations about mode shift but does not address port freight or Yantian’s targets specifically.
5. It describes push-and-pull policies—expanding public transport while discouraging car dependence—that illustrate measures capable of accelerating passenger mode shift. These measures offer policy context but are not specific to Yantian Port’s freight transport or its 2035 targets.
6. This passage concerns how local governments’ sustainable transportation plans and emissions targets are assessed, providing a framework for evaluating Shenzhen’s planning commitments. It does not state Yantian’s mode-shift targets or whether a stated-policy trajectory can achieve them.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (3133 ms)
1. The passage states that Yantian Port’s future container distribution plan will rely on railways and waterways for a large share of throughput, directly tying the port to potential road-to-rail (intermodal) expansion. It provides the strategic context needed to discuss what factors may enable or limit that shift at Yantian.
2. It identifies key barriers to rail intermodality in China—specifically uncompetitive railway pricing, underdeveloped intermodal services, and limited rail service quality. These factors directly correspond to obstacles for expanding road-to-rail intermodal transport at a port like Yantian.
3. The passage frames intermodal expansion as a tactic (shifting freight to rail/waterways and investing in intermodal infrastructure), which helps clarify what capabilities and investments are required. By implication, it points to barriers such as inadequate intermodal infrastructure and services that would hinder road-to-rail scaling.
4. It explicitly recommends promoting sea-to-rail or sea-to-water intermodal services at Shenzhen port (near Yantian), which is closely related to intermodal transport involving road/land connections. This provides port-level policy or action guidance that reflects practical constraints and requirements for intermodal scaling.

**gpt-6-luna** (3186 ms)
1. This passage directly addresses Yantian Port’s planned shift toward rail and water transport, but the excerpt is truncated before giving specific barriers to achieving that shift.
2. It identifies barriers relevant to expanding rail-based intermodal freight in China: uncompetitive railway pricing, underdeveloped intermodal services, and limited rail service quality. These are broader national constraints, not specifically attributed to Yantian Port.
3. It recommends shifting freight to rail and water and investing in intermodal infrastructure, indicating that infrastructure and service development are relevant to expansion. It does not specify Yantian-specific barriers.
4. It recommends promoting sea-to-rail and sea-to-water services at Shenzhen Port, a policy direction relevant to Yantian’s intermodal expansion. The passage does not describe the obstacles to implementing those services.

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (8618 ms)
1. This case study discusses the need for aggressive measures like freight mode shift and upstream grid decarbonization to reduce remaining emissions, which are core components of comparing drayage electrification versus rail/water shift. It provides the framing needed for a well-to-wheel CO2 decline comparison, even though it does not quantify the exact 95% Yantian scenario.
2. This passage focuses on decarbonization pathways for China’s road transport, including when emissions can peak under different policy strengths. While it does not give Yantian-specific well-to-wheel numbers or a 95% drayage electrification target, it supports the plausibility of estimating emissions impacts from electrification measures.
3. It highlights that achieving carbon neutrality requires increased ambition on structural changes and vehicle electrification, referencing policy directions like Table ES-2. This is relevant background for electrification adoption levels (such as reaching 95% by 2035) but does not provide the specific magnitude of well-to-wheel CO2 reductions or compare to rail/water shift quantitatively.
4. This source is about policies to accelerate zero-emission heavy-duty trucks, providing technical context and terminology (battery-electric, fuel-cell, charging infrastructure). That helps interpret what “drayage truck electrification” means for emissions calculations, but it does not provide the quantified Yantian well-to-wheel decline or direct comparison to rail and water measures.
5. This work explicitly argues that electrification alone is insufficient and that multiple measures are needed, and it describes modeling using national traffic and electricity models. That is directly relevant to well-to-wheel CO2 framing and the comparison between electrification and other measures, though it still does not contain the specific Yantian 95% by-2035 quantified estimate versus rail/water shift.
6. This passage focuses on decarbonizing Hong Kong’s roads with recommendations such as improving public transit and active mobility, which is more passenger-focused. It does not address drayage trucks at Yantian Port or mode shift to rail/water for freight, so it is not directly useful for the query’s required comparison.
7. It mentions port-related initiatives like piloting low-carbon ports and distributed energy, which are upstream/port-side measures that influence well-to-wheel emissions. However, it does not quantify how much well-to-wheel CO2 would decline from reaching 95% drayage electrification by 2035, nor does it provide comparable rail/water mode-shift effects.
8. This passage proposes a transport-sector quantified climate goal including a shift to green fuels and reduced transport energy use by 2035 across all modes. While helpful for context on what types of measures matter by 2035, it does not provide the specific drayage electrification at Yantian Port or any quantified comparison to rail and water mode shift.
9. This is about sustainable urban mobility in NDCs and the role of public transport, which is not freight drayage or port mode shift between trucks, rail, and water. Therefore, it does not provide information needed for calculating well-to-wheel CO2 declines from drayage electrification versus rail/water shift.
10. This includes a table on the impact of electrification under low- and high-ambition scenarios on percentage CO2 emissions reduction by 2030 and 2050. It is relevant to electrification impact estimation in general, but it lacks Yantian Port specificity, a 95% by-2035 drayage scenario, and a rail/water mode-shift comparison.
11. The passage directly states that pairing with train electrification and grid modernization increases emission reduction potential and explicitly calls to invest in and electrify freight rail. This directly connects to the query’s request to compare electrified drayage impacts against rail-related measures, but it still does not provide the numeric Yantian 95% by-2035 well-to-wheel decline.
12. It provides techno-economic feasibility for zero-emission trucks in delivery use cases, which can support the assumptions behind electrification emissions calculations. However, it does not quantify well-to-wheel CO2 declines at Yantian Port for a 95% by-2035 drayage target, nor does it quantify rail and water mode-shift measures for comparison.
13. This passage is about interventions that shift freight from trucks to rail (freight TDM). That makes it directly relevant to the query’s comparison component—how rail mode shift measures stack up against drayage electrification—though it does not provide the Yantian-specific 95% electrification result or numerical well-to-wheel CO2 declines.
14. This is mostly methodological assumptions and truck lifecycle assumptions used in a feasibility analysis, which may affect how emissions (including well-to-wheel) are calculated. It is not directly tied to Yantian Port or rail/water mode shift comparisons, and it lacks the requested quantified CO2 decline under a 95% by-2035 drayage scenario.
15. It discusses prioritizing zero-emission logistic vehicles and provides policy interventions (such as subsidies) for adoption in the near term. This can inform how to interpret electrification adoption rates like 95% by 2035, but it does not present the specific well-to-wheel CO2 reduction at Yantian Port or any quantitative rail versus water mode-shift comparison.

**gpt-6-luna** (9975 ms)
1. This Shenzhen Port case study directly addresses port decarbonization and notes that further emission reductions depend on freight mode shifts and cleaner grid electricity. The excerpt does not provide the requested 95%-electrification estimate or a numerical comparison with rail and water measures.
2. This source concerns strategies for reducing emissions from China's road transport, providing broader context for truck electrification. It does not specifically address Yantian Port, drayage, or the requested comparison with rail and water mode shifts.
3. The passage discusses the need for stronger vehicle-electrification and structural-change policies in China, which is relevant background for evaluating drayage electrification and freight mode shifts. It gives no Yantian-specific emissions estimate.
4. This report concerns policies to accelerate zero-emission heavy-duty trucks in China, making it relevant background for truck electrification assumptions. The excerpt does not give the Yantian Port well-to-wheel reduction or compare it with rail and water measures.
5. This study describes the broader role and scale of road-transport emissions in China and notes that vehicle electrification alone is insufficient for net zero. It does not provide the requested port-specific estimate or mode-shift comparison.
6. This passage concerns decarbonization pathways for Hong Kong roads, offering regional context on transport emissions and policy. It does not address Yantian drayage trucks or rail and water freight shifts.
7. The passage mentions low-carbon port initiatives and transport electrification in Chinese policy examples, which is relevant general context for port decarbonization. It does not quantify Yantian's drayage emissions reduction or compare the measures asked about.
8. This passage proposes a broad 2035 transport-sector target involving green fuels and lower energy use, providing general context for transport decarbonization. It does not quantify drayage electrification at Yantian or compare rail and water shifts.
9. This source concerns public transport measures in national climate plans, rather than freight-port emissions. It does not contribute a Yantian-specific estimate or a comparison of drayage electrification with rail and water mode shifts.
10. This passage concerns emissions reductions from transport electrification in India, which is only general comparative context. It does not address Yantian Port or the requested freight-mode comparison.
11. The passage mentions that emission reductions can increase when rail electrification and grid modernization are included, directly relating to comparison with rail measures. It does not provide the Yantian-specific drayage estimate or discuss water mode shift in the excerpt.
12. This study evaluates zero-emission truck feasibility in Guangdong, offering regional context about truck technology. The excerpt is a fragment of a technical table and does not state the requested Yantian emissions reduction or mode-shift comparison.
13. The passage explicitly describes freight demand management as shifting freight from trucks to rail, which is relevant to comparing electrification with rail mode shift. It concerns Mexico and gives no Yantian-specific estimate or water-shift comparison.
14. This excerpt describes assumptions used in a Guangdong zero-emission truck feasibility study, providing background on truck lifetimes and costs. It does not address port emissions or the requested rail and water comparison.
15. This passage recommends zero-emission logistics vehicles in cities in Guangdong, making it regionally relevant to truck electrification policy. It does not provide a Yantian Port well-to-wheel estimate or compare electrification with rail and water mode shifts.

## batch-relates

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (1973 ms)
1. Provides China 2035 projected new energy heavy-duty truck penetration ranges by regional and long-haul scenarios.
2. Supplies modeling inputs and definitions supporting the report’s 2035 penetration projections for zero-emission heavy-duty trucks.
3. Discusses broader decarbonization strategies and vehicle transition context, without specific 2035 penetration rates.

**gpt-6-luna** (2116 ms)
1. Projects regional zero-emission truck penetration above 50% by 2027–2030 and long-haul penetration around 15%–53% by 2035 under strengthened policies.
2. Provides truck-use assumptions for the same study but does not state projected market penetration rates.
3. Discusses low-carbon vehicle deployment in China but gives no specific heavy-duty truck penetration projection through 2035.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (5269 ms)
1. Reports Guangdong case study where battery-electric HDTs reach TCO parity with diesel before MY2025 for 42-ton tractor trailers.
2. Discusses China road transport decarbonization and cites prior work on evaluating electric vehicle costs and benefits including TCO.
3. Explicitly references an ICCT study comparing TCO for battery-electric, fuel-cell, and diesel heavy trucks in China.
4. Covers policy acceleration for zero-emission HD trucks but does not provide specific China TCO comparisons.
5. References research on zero-emission HD truck policies, without direct quantitative TCO comparison between BEVs and diesel.
6. States studies suggest BEV trucks in China will achieve lower total cost, but provides no detailed diesel comparison.
7. Focuses on carbon-neutrality strategies rather than providing explicit BEV-vs-diesel heavy-truck TCO results.
8. Explains that port adoption of battery-electric HDTs depends on TCO feasibility versus diesel equivalents.
9. Cites the ICCT TCO study for battery-electric, fuel-cell, and diesel heavy trucks in China.
10. Provides TCO comparison charts for heavy-duty truck types showing BEVs can reach 1:1 replacement parity with diesel.
11. Addresses zero-emission freight zones using abatements and scenarios; TCO comparison between BEV and diesel isn’t shown.
12. Sets up an emissions/TCO framework for Hong Kong but not China heavy-truck TCO comparison outcomes.
13. Presents a tool comparing diesel and battery-electric buses across procurement, operations, and maintenance costs (bus TCO).
14. Generalizes that electric vehicles have lower lifetime cost than diesel, but not China heavy-duty truck TCO.
15. Describes how TCO is calculated for electric buses, without China heavy-duty truck BEV-vs-diesel results.
16. Provides methodology for transport emissions and social costs; does not compare heavy-truck TCO by powertrain.
17. Shows electric bus cost benefits (fuel and maintenance reductions) but not heavy-duty truck BEV-vs-diesel TCO in China.
18. Discusses TCO gap for electric versus diesel buses in the US, not China heavy-duty trucks.
19. Introduces a tool to compare zero-emission and diesel trucks via total cost of ownership, but for India.
20. Provides TCO comparison for electric auto-rickshaws versus ICE, not heavy-duty trucks in China.

**gpt-6-luna** (6078 ms)
1. Finds battery-electric trucks in Guangdong can reach TCO parity with diesel before model year 2025, especially 42-ton tractors.
2. Discusses China’s road-transport decarbonization but provides no truck TCO comparison in the snippet.
3. Cites a detailed China study comparing battery-electric, fuel-cell, and diesel heavy-truck TCO.
4. Focuses on policies for zero-emission freight trucks, but the snippet gives no TCO comparison.
5. References research on battery-electric versus diesel truck costs, without stating comparative TCO results.
6. Notes studies of Chinese BEV truck TCO, but gives no comparison or cost findings.
7. Covers China’s transport decarbonization strategy, but the snippet provides no heavy-truck TCO results.
8. Reports that carriers’ electric-truck adoption depends partly on TCO relative to diesel, without giving comparative figures.
9. Cites a study directly comparing battery-electric, fuel-cell, and diesel heavy-truck TCO in China.
10. Compares Chinese heavy-truck TCO and says some battery-electric types reach parity with diesel under ideal one-for-one replacement.
11. Addresses zero-emission freight-zone costs, but the snippet does not compare electric and diesel truck TCO.
12. Concerns Hong Kong road transport and mentions TCO, but not China’s electric-versus-diesel truck costs.
13. Compares bus TCO across technologies, not heavy-duty trucks in China.
14. Discusses electric-vehicle ownership costs outside China and does not compare truck TCO.
15. Analyzes electric-bus TCO and battery degradation, not Chinese heavy-truck costs.
16. Provides China transport emissions methodology, not a truck TCO comparison.
17. Compares electric and conventional bus ownership costs, not heavy trucks in China.
18. Examines US school-bus TCO, not battery-electric and diesel heavy trucks in China.
19. Compares electric and diesel truck TCO in India, rather than China.
20. Analyzes Indian auto-rickshaw ownership costs, not Chinese heavy-duty trucks.

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2530 ms)
1. Reports modest regional ZET market share (2–17%) by MY2030 and nascent long-haul adoption through MY2035.
2. Provides scenario assumptions and sensitivity framing contrasting regional delivery versus long-haul contexts.
3. Discusses delayed market tipping for NEV heavy-duty trucks, implying slower adoption timelines overall.
4. States zero-emission vehicle promotion has greatest decarbonization potential, without separating regional vs long-haul adoption.
5. Evaluates how zero-emission freight zones affect long-haul/regional-haul transportation and goods supply.
6. Shows BEVs suit most urban/regional delivery while FCEVs better fit long-range and cold-chain scenarios.
7. Examines techno-economic feasibility for urban and regional delivery use cases, not long-haul adoption directly.
8. Continuation of the same techno-economic case study references regional delivery feasibility rather than long-haul adoption.
9. Presents a financial assessment tool for ZETs vs ICE trucks, not regional versus long-haul adoption potential.

**gpt-6-luna** (3286 ms)
1. It directly compares adoption: regional delivery reaches 2–17% ZET share by 2030 without incentives, while long-haul remains nascent through 2035.
2. It defines regional-delivery and long-haul scenario abbreviations but provides no adoption comparison.
3. It discusses differing truck decarbonization timelines by duty cycle, but does not quantify regional-versus-long-haul adoption potential.
4. It examines zero-emission vehicle decarbonization potential in Guangdong, without comparing regional and long-haul truck adoption.
5. It considers regional and long-haul transport impacts from freight-zone scenarios, not their relative zero-emission truck adoption potential.
6. It contrasts urban truck technologies and use cases, but does not compare regional with long-haul adoption scenarios.
7. It analyzes urban and regional delivery feasibility, but the snippet does not compare adoption potential with long-haul transport.
8. It analyzes urban and regional delivery feasibility, but the snippet does not compare adoption potential with long-haul transport.
9. It assesses individual truck financial feasibility, not adoption differences between regional and long-haul scenarios.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (4185 ms)
1. Provides ZET residual value assumptions and cost-competitiveness drivers, necessary inputs for payback-period comparisons.
2. Reports when BETs reach TCO parity with diesel by MY2027, informing the implied payback timing.
3. Details residual value sensitivity (e.g., 30% residual), a key factor determining payback periods.
4. States BETs reach TCO parity versus diesel before MY2027 in multiple Guangdong use cases.
5. Defines payback period and its comparison between diesel and e-trucks, but not China-specific results.
6. Discusses decarbonization strategies and references EV cost-evaluation literature, but no explicit payback periods.
7. Cites an ICCT TCO study for heavy trucks in China, which likely underpins payback-period estimates.
8. Shows BEV vs diesel TCO cost differences and break-even mileage, which corresponds to payback timing.
9. Discusses constraints of electric heavy trucks in China but provides no payback-period comparison.
10. References a heavy-truck TCO-in-China study, likely containing payback period comparisons.
11. Cites heavy-truck TCO work for China but does not provide direct payback-period figures.
12. Focuses on port logistics with diesel truck emissions and modal shifts, not payback periods.
13. Links zero-emission trucks to reaching TCO parity with diesel, but for Hong Kong, not China payback periods.

**gpt-6-luna** (3663 ms)
1. Discusses electric-truck residual values, which affect payback calculations, but gives no payback period.
2. Reports battery-electric trucks reaching total-cost parity with diesel in Guangdong, not their payback periods.
3. Examines residual-value assumptions for zero-emission trucks, a factor in payback, but provides no period.
4. Compares electric and diesel truck total costs in Guangdong but does not state payback periods.
5. Defines payback period as a comparison metric for diesel and electric trucks, but gives no China-specific results.
6. Addresses China’s road-transport decarbonization, but the snippet does not provide truck payback periods.
7. Cites a China heavy-truck total-cost study, but supplies no payback-period figures.
8. Gives electric-truck cost gaps and mileage thresholds versus diesel in Beijing, but not payback periods.
9. Discusses electric heavy-truck technology in China, without comparing payback periods.
10. Cites a China heavy-truck total-cost study, but provides no payback-period results.
11. Cites a China battery-electric and diesel truck cost study, but gives no payback periods.
12. Examines diesel-truck alternatives at Shenzhen port, but does not report electric-truck payback periods.
13. Discusses electric-truck total-cost parity in Hong Kong, not payback periods in China.

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (6036 ms)
1. Reports survey results that 17%–45% of bike-share trips replaced private motorized trips in Chinese cities.
2. Analyzes passenger mode shares in China but does not isolate bike-share replacement of cars/taxis/ride-hailing.
3. States that 17%–45% of trips replaced private motorized (private car/taxi/ride-hailing) trips and includes 54% used for transit access.
4. Discusses electric mobility targets in Vietnamese cities, not bike-share trip replacement in China.
5. Provides general background on bicycle-sharing and safety, without replacement shares for China.
6. Describes the emergence and growth of dockless bike-sharing in China, not replacement shares.
7. Notes bike-sharing is encouraged across many Chinese cities, without quantifying mode replacement.
8. Shows mode shares for Johannesburg, not China bike-share trip substitution.
9. Discusses whether ride-hailing replaces or adds to private car miles, not China bike-share replacement shares.
10. Focuses on Hong Kong road decarbonization, not China bike-share substitution of car/taxi/ride-hailing.
11. Addresses safety for bicycles as last-mile transport but provides no replacement percentages.
12. Gives methodology for emissions/cost assessment, not bike-share trip replacement shares.
13. Explains ride-hailing as a mode substitute in general terms, without China bike-share replacement figures.
14. Covers bike-sharing implementation lessons in India, not China and not replacement shares.
15. Provides a guide for assessing micromobility environmental impacts, not China replacement shares.
16. Discusses ride-sharing additionality and data gaps, not measured bike-share replacement in China.
17. Describes shared mobility trends globally, without China-specific replacement shares.
18. Provides mode shares for Surabaya, Indonesia, unrelated to China bike-share substitution.
19. Characterizes dockless bikes as independent travel alternatives, without quantifying replacement shares in China.
20. Models electric vehicle adoption impacts in China, not bike-share trip replacement of car/taxi/ride-hailing.
21. Summarizes informal services in Latin America, not China bike-share replacement.
22. Gives context on bicycle-sharing adoption and vehicle ownership growth in China, not replacement percentages.
23. Presents public space intervention mode split in Guadalajara, not China bike-share replacement shares.
24. Studies commuting mode choice in Bengaluru, not China bike-share trip replacement of cars/taxis/ride-hailing.
25. Models aggregator impacts for India’s mobility, not China bike-share replacement shares.
26. Discusses transport demand management strategies in Mexico, not China bike-share replacement shares.

**gpt-6-luna** (6311 ms)
1. It notes cycling’s potential to replace short motorized trips but provides no share for cars, taxis, or ride-hailing.
2. It discusses China’s transport mode shares but gives no bike-share substitution percentage.
3. It reports that 17–45% of bike-share trips replace private motorized trips, directly answering the question.
4. It concerns electric mobility in Vietnamese cities, not bike-share substitution in China.
5. It mentions China’s bike-share systems but gives no trip-replacement share.
6. It describes bike-share growth in China without reporting which trips bike sharing replaces.
7. It notes bike-share expansion in Chinese cities but gives no substitution percentage.
8. It reports travel modes in Johannesburg, not bike-share substitution in China.
9. It discusses ride-hailing substitution in other regions, not bike-share trips in China.
10. It concerns Hong Kong road transport, not bike-share substitution across China.
11. It addresses safe access to public transport in China but gives no bike-share replacement share.
12. It lists transport modes for emissions assessment without bike-share substitution data.
13. It discusses ride-hailing competition in other countries, not China bike-share trip replacements.
14. It examines bike sharing in India rather than replacement shares in China.
15. It explains how to assess micromobility emissions but reports no China-specific substitution share.
16. It discusses on-demand ride-sharing substitution, not bike-share trips in China.
17. It broadly discusses shared mobility but gives no China bike-share replacement percentage.
18. It reports transport mode shares in Surabaya, not Chinese bike-share substitution.
19. It describes mobility alternatives without quantifying bike-share trips replacing motorized trips in China.
20. It concerns electric-vehicle adoption in China, not bike-share trip replacement.
21. It examines informal transport in Latin America, not Chinese bike-share substitution.
22. It describes China’s bike-share expansion but gives no share of trips replacing motorized modes.
23. It reports Guadalajara travel modes, not bike-share substitution in China.
24. It concerns commuting choices in Bengaluru, not bike-share substitution in China.
25. It compares trip costs for Indian transport modes, not bike-share replacement shares in China.
26. It discusses transport strategies in Mexico without China bike-share substitution data.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (3937 ms)
1. Reports dockless bike sharing in Chinese cities and estimates annual CO2 reduction of 4.8 million tonnes.
2. Finds dockless bike sharing in China reduces CO2 by about 4.8 million tonnes annually.
3. Discusses decarbonizing transport but provides no bike-sharing-specific CO2 reduction estimate.
4. Provides general bike-sharing examples and health impacts without quantifying CO2 reductions in China.
5. Mentions bike-sharing size and air-pollution/health risk findings, not CO2 reduction amounts.
6. Provides national/emerging-economy climate modeling, not CO2 reduction attributed to China bike-sharing.
7. Covers transport CO2 accounting methodologies and trends, not bike-sharing reduction figures.
8. Describes bike-sharing technology and integration, without estimating CO2 emissions reduction in China.
9. Offers transport emissions assessment methodology without any bike-sharing CO2 reduction attribution.
10. Analyzes road transport emissions for China but does not quantify bike-sharing CO2 reductions.
11. Discusses shared micromobility environmental impact accounting methods, not China bike-sharing CO2 amounts.
12. Scenario analysis for transport decarbonization emphasizing shared mobility, without CO2 reduction attributed to bike-sharing.
13. Calculates bicycle-sharing CO2 for India using a car substitution assumption; China bike-sharing not covered.
14. Reviews China net-zero and air pollution/emissions context without bike-sharing-specific CO2 reduction.
15. Zero-emission trucks feasibility in Guangdong; no bike-sharing CO2 reduction quantified.

**gpt-6-luna** (3681 ms)
1. Dockless bike-sharing in China is estimated to reduce CO₂ emissions by 4.8 million tonnes annually.
2. The report estimates that bike-sharing in China reduces CO₂ emissions by about 4.8 million tonnes each year.
3. Discusses China’s transport decarbonization strategies but gives no bike-sharing reduction figure.
4. Describes Chinese bike-sharing systems and health benefits without quantifying CO₂ reductions.
5. Describes China’s bike-sharing systems but provides no CO₂ reduction estimate.
6. Covers broad urban emissions reductions, not bike-sharing’s contribution in China.
7. Discusses transport emissions accounting in China without a bike-sharing reduction figure.
8. Discusses bike-sharing integration in Chinese cities but does not quantify its CO₂ reductions.
9. Addresses transport emissions in Chinese cities but not bike-sharing’s quantified impact.
10. Analyzes China’s road transport emissions without stating bike-sharing’s CO₂ reduction.
11. Provides a general guide to shared-micromobility emissions assessment, not China’s specific reduction amount.
12. Focuses on India’s transport decarbonization rather than bike-sharing emissions reductions in China.
13. Examines public bicycle sharing in India, not its CO₂ reduction in China.
14. Discusses China’s urban climate challenges but not bike-sharing’s emissions reduction.
15. Studies zero-emission trucks in Guangdong, not bike-sharing’s CO₂ reduction.

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (4394 ms)
1. Analyzes how dockless bike-sharing in Chinese cities changes travel behavior and city outcomes.
2. Same report chapter framing how shared bikes affect urban mobility patterns in China.
3. Describes the rapid emergence and scale of dockless bike-sharing in China, contextualizing behavioral impacts.
4. Provides safety/design context for bike-sharing, indirectly relevant to travel behavior effects.
5. Discusses bicycle-sharing safety and health co-benefits from other cities, indirectly informing behavior shifts.
6. Examines transport mode shares and emissions in China, potentially related to shifts from bike-sharing adoption.
7. Covers public transport accessibility design, not dockless bike-sharing specifically.
8. Gives broader context on shared bike proliferation in many Chinese cities and competing car growth trends.
9. Methodology for transport emissions/cost assessment in Chinese cities, not bike-sharing behavior.
10. City guide for assessing environmental impacts of shared micromobility, not travel behavior specifically.
11. Discusses electric mobility roadmap for Vietnamese cities, unrelated to Chinese dockless bike-sharing behavior.
12. Focuses on first/last-mile solutions and shared rides generally, not dockless bike-sharing in China.
13. Defines shared mobility and responsive transit concepts, without China-specific dockless bike-sharing behavior findings.
14. Reports on dockless PBS implementation in India, which is only indirectly relevant as a comparative case.
15. Lessons from cycling schemes in Mexico City and Guadalajara, indirectly relevant to interpreting behavior impacts.
16. Examines cycling policy and infrastructure safety, indirectly supporting mechanisms for travel behavior changes.
17. Assesses local low-carbon policy coverage, with no direct linkage to dockless bike-sharing travel behavior.

**gpt-6-luna** (4476 ms)
1. This report directly analyzes how dockless bike-sharing changes travel and other aspects of life in Chinese cities.
2. This Chinese-language report directly examines dockless bike-sharing’s effects on travel behavior in Chinese cities.
3. It outlines dockless bike-sharing’s rapid growth in China but does not detail its effects on travel behavior.
4. It discusses conventional bike-sharing in China, not dockless systems or their travel-behavior effects.
5. It describes Chinese bike-sharing’s scale but focuses on conventional systems and health impacts elsewhere.
6. It addresses transport mode-share changes in China but does not specifically assess dockless bike-sharing’s effects.
7. It cites a Chinese bike-sharing report but does not explain dockless systems’ effects on travel behavior.
8. It notes bike-sharing’s prevalence across Chinese cities without describing its effects on travel behavior.
9. It concerns transport-emissions assessment methods, not bike-sharing or travel behavior changes.
10. It discusses environmental assessment of shared micromobility, including dockless operations, but not Chinese travel behavior.
11. It addresses electric mobility in Vietnamese cities, not dockless bike-sharing in China.
12. It discusses first- and last-mile transit connections but does not address dockless bike-sharing’s effects in China.
13. It surveys demand-responsive transit rather than dockless bike-sharing or its effects on Chinese travel behavior.
14. It describes dockless bike-sharing implementation in India, not its travel effects in Chinese cities.
15. It concerns cycling schemes in Mexican cities, not dockless bike-sharing’s effects in China.
16. It discusses cycling infrastructure and travel during COVID-19, not dockless bike-sharing in Chinese cities.
17. It discusses local climate and mobility policy but does not address dockless bike-sharing’s travel effects.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (1975 ms)
1. Examines Yantian Port inland transport emissions but not mode-shift targets or 2035 Master Plan feasibility.
2. Discusses near-term need for more proactive mode-shift beyond stated policy trajectory in Shenzhen context.
3. Defines scenario trajectories including a stated-policy baseline versus deeper structural change via mode shift.
4. Assumes high green transport mode share in stated-policy scenario by 2030, relevant to comparing against stricter targets.
5. Presents mode-shift policy levers (“pull and push”) but lacks Shenzhen 2035 target evaluation.
6. Reviews how local governments set sustainable transport plans and targets, without analyzing Yantian’s meeting 2035 mode shift.

**gpt-6-luna** (2451 ms)
1. Analyzes Yantian’s transport emissions and distribution system, directly informing whether port mode-shift targets are achievable.
2. Compares transport decarbonization measures and mode-shift ambition, but does not specifically assess Yantian or Shenzhen’s 2035 targets.
3. Defines stated-policy and stronger structural-change scenarios, offering a framework to compare mode-shift ambition.
4. Describes stated-policy urban green-transport assumptions, but not Yantian’s freight targets or feasibility.
5. Outlines policy tools for shifting transport toward public transit, without assessing port freight or target feasibility.
6. Classifies local sustainable-transport plans and targets, but provides no Yantian-specific feasibility analysis.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2098 ms)
1. Predicts Yantian Port will shift toward railways and waterways, implying expansion barriers like capacity and mode share constraints.
2. Identifies barriers including uncompetitive rail pricing, underdeveloped intermodal services, and limited service quality in China.
3. Suggests barriers/needs for expansion are intermodal infrastructure, equipment, service connectivity, pricing, and scheduling improvements.
4. Recommends promoting sea-to-rail intermodal services at Shenzhen/Yantian region, implying current service gaps as a barrier.

**gpt-6-luna** (1932 ms)
1. Projects rail and waterway growth at Yantian but does not identify barriers to achieving it.
2. Identifies uncompetitive rail pricing, underdeveloped intermodal services, and poor rail service quality as barriers in China.
3. Recommends infrastructure, equipment, connectivity, pricing, scheduling, and first-/last-mile improvements that address intermodal barriers.
4. Recommends sea-to-rail services at Shenzhen Port but does not specify barriers to expanding them.

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (4839 ms)
1. Discusses Shenzhen port decarbonization and highlights road-to-rail as largest decarbonization mode-shift measure.
2. Provides sector-wide shares for electrification and structural changes, including freight mode shifts relevance to 2035.
3. Quantifies needed electrification and freight mode-share structural changes for China’s mitigation pathways.
4. Focuses on policies for zero-emission heavy-duty trucks, but not Yantian or well-to-wheel CO2 totals.
5. States that net-zero requires substantial freight mode shift and heavy-duty electrification, but no drayage-specific WTW numbers.
6. Recommends transport decarbonization strategies, but does not quantify Yantian drayage WTW or compare rail/water.
7. Mentions “low-carbon port” pilots and targets for freight mode shares, including rail-water increases by 2030.
8. Gives transport-sector targets for fuels and energy reductions by 2035, applicable but not drayage-at-Yantian-specific.
9. Covers public transport in NDCs, unrelated to drayage trucking well-to-wheel CO2 or rail-water shift comparisons.
10. Scenario table includes emission-reduction impacts of electrification, but no drayage/port/WTT comparison metrics.
11. Argues for electrifying freight rail and shifting away from road toward rail/water for lower GHG.
12. Analyzes techno-economic feasibility of zero-emission trucks in Guangdong; no WTW CO2 or Yantian port results.
13. Describes freight TDM aimed at shifting freight from trucks to rail, but lacks CO2/WTT quantification for Yantian.
14. Provides abbreviations and feasibility framing for zero-emission trucks, without Yantian drayage WTW CO2 declines.
15. Recommends accelerating zero-emission drayage trucks in Shenzhen/nearby, directly relevant but no quantitative WTW CO2 decline.

**gpt-6-luna** (4876 ms)
1. The Shenzhen Port case study directly compares port decarbonization measures, including drayage electrification and rail or water freight shifts.
2. This national road-transport study discusses electrification and freight mode shifts but gives no Yantian-specific comparison.
3. This study addresses nationwide road-freight mode shifts and vehicle electrification, not Yantian Port emissions.
4. This report concerns zero-emission heavy trucks in regional and long-haul freight, not port-specific well-to-wheel impacts or mode shifts.
5. This China-wide pathway includes heavy-truck electrification and road-to-rail or water shifts, but no Yantian-specific estimates.
6. This study concerns Hong Kong road-transport decarbonization rather than Yantian Port drayage or freight mode shifts.
7. This document discusses provincial transport policies and port decarbonization, but not Yantian’s electrification scenario comparison.
8. This global transport-goal paper mentions electrification and sustainable mode shifts without estimating port-specific emissions reductions.
9. This paper focuses on public transport in national climate pledges, not freight drayage or port emissions.
10. This India-focused scenario analysis addresses transport electrification, not Yantian Port or its rail and water measures.
11. This report broadly supports freight shifts toward rail and water but provides no Yantian-specific emissions estimate.
12. This Guangdong truck-feasibility study includes port-use cases but does not compare Yantian electrification with mode shifts.
13. This Mexico transport pathway discusses shifting freight from trucks to rail, not Yantian Port scenarios.
14. This Guangdong zero-emission truck study includes port-operation cases but lacks the requested Yantian well-to-wheel comparison.
15. This Guangdong pathway recommends zero-emission drayage trucks but does not quantify Yantian outcomes against rail and water shifts.

## alignment

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (1785 ms)
1. One source directly projects ZET penetration for China’s regional-delivery and long-haul heavy-duty truck scenarios, but only up to 2030 (not 2035): ~2%–17% under a no-policy case.
2. The other highly relevant items appear to discuss models/policies and technical parameters (e.g., annual vehicle kilometers traveled, charging), yet the provided excerpts don’t state an explicit 2035 market-penetration number.
3. A lower-relevance WRI authors’ piece includes partial projections but the excerpt focuses on operational decarbonization strategies, not a clear 2035 market penetration rate for new energy heavy-duty trucks.
4. Because all retrieved sources are Chinese and the excerpt coverage stops at 2030, the evidence for “through 2035” is incomplete; a targeted query for “2035 penetration rate / adoption curve” is needed.

**gpt-6-luna** (4613 ms)
1. Two highly relevant sources address China’s zero-emission heavy-duty truck uptake through 2035; retrieved publications include Chinese-language material.
2. The excerpt gives only a no-policy 2030 estimate: regional-delivery penetration of about 2%–17%; it does not establish a single 2035 rate or long-haul estimate.
3. The second excerpt lists vehicle-use assumptions, not penetration projections, while the third is weakly relevant; refine by specifying policy scenario and regional versus long-haul trucks.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (1778 ms)
1. Most results focus on China-specific TCO comparisons for heavy trucks, including battery-electric vs diesel, via the Guangdong/port-delivery case study and related techno-economic feasibility work.
2. A key strong source is Mao et al. (2021) on “Total Cost of Ownership for Heavy Trucks in China” explicitly comparing battery-electric, fuel-cell electric, and diesel—ideal for direct TCO side-by-side.
3. Coverage appears largely China-and-delivery oriented; missing are nationwide operations detail (routes, duty cycles), assumed electricity prices, utilization rates, and discount rates that drive TCO swings.
4. Because all retrieved items are Chinese-language publications, cross-checking with English summaries or meta-analyses (same assumptions) would reduce risk of incomplete interpretation of methods.

**gpt-6-luna** (4002 ms)
1. The Guangdong delivery-use case study and a cited China heavy-truck ownership-cost analysis directly match the comparison, but excerpts provide no cost figures or conclusions.
2. Results include Chinese-language publications; available snippets do not reveal whether estimates account for purchase price, energy, maintenance, battery replacement, or incentives.
3. Use the underlying cost study and specify truck duty cycle, annual mileage, ownership period, and subsidy assumptions to make the BEV–diesel comparison actionable.

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (1947 ms)
1. A China-focused study reports regional delivery (MY2030) has a modest ZET market share of ~2–17% without incentives, implying low adoption early under policy lag.
2. The long-haul vs regional contrast is implied by scenario-focused work on vehicle deployment potential, but the provided excerpts don’t quantify the long-haul adoption share directly.
3. Policy sensitivity assumptions (e.g., 30% residual value for ZETs) indicate adoption gaps between scenarios depend heavily on incentives and economics, not only routing distance.
4. Evidence is largely from Chinese-language sources; missing: explicit, side-by-side numerical adoption potentials for both regional and long-haul in a single consistent framework.

**gpt-6-luna** (4870 ms)
1. The lead study directly compares regional and long-haul trucking: without incentives, regional ZET market share reaches 2–17% by MY2030, while long-haul adoption remains nascent.
2. Most other results address broader road-transport decarbonization or freight-zone impacts, so they offer limited direct evidence for quantifying the adoption gap; the supplied excerpts are also incomplete.
3. Relevant publications include Chinese-language sources. Refine the query by specifying the target year and policy scenario, such as adoption potential with versus without purchase incentives.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (1684 ms)
1. China-focused sources model BET cost advantages and explicitly track payback period alongside TCO and discounted cash flows, but the provided excerpts don’t report numeric payback-period values.
2. At least one study assumes residual value for diesel trucks (~30% retained), which can materially shift BET payback results; without full parameter values, comparisons are uncertain.
3. Results are heavily Chinese-language and appear concentrated on specific corridors/use cases (e.g., port operations, urban/regional delivery), leaving gaps for other semi-truck classes, routes, and charging infrastructure assumptions.

**gpt-6-luna** (5451 ms)
1. China-focused sources cover zero-emission heavy-duty trucks and Guangdong delivery cases, but the excerpts provide no direct battery-electric semi-truck versus diesel payback figures.
2. The Guangdong study discusses total-cost-of-ownership parity across port, distribution, and urban uses; these scenarios may not represent long-haul semi-truck operations.
3. Chinese-language publications are included; refine the search around semi-truck payback periods, duty cycles, purchase incentives, and the comparison year to locate comparable estimates.

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (1805 ms)
1. Only one retrieved Chinese WRI report directly addresses substitution: it states 17%–45% of trips replace private car, taxi, or ride-hailing (range depends on trip type).
2. The key finding is framed as replacing short-distance motorized trips and connecting to public transit (54% for transfers; 91% of those connect to transit), not necessarily full “mode-to-mode” shares.
3. Other results are either methodological/background (e.g., decarbonization strategies) or lack the specific replacement share needed for China-wide estimates.
4. To improve, refine to “modal replacement share of dockless bike sharing” and ask for “private car/taxi/ride-hailing substitution by trip distance” for comparable datasets across major Chinese cities.

**gpt-6-luna** (4895 ms)
1. A Chinese WRI report says 17%–45% of trips replaced private motorized travel, but the excerpt does not specify the share replacing cars, taxis, or ride-hailing individually.
2. The dockless-bike study is relevant and reports survey evidence (n=6,902), but its excerpt emphasizes walking and buses rather than the requested replacement share; several other results are tangential.
3. Relevant results include Chinese-language publications. Refine the query to ask for mode-specific substitution estimates for bike-share trips in Chinese cities, including survey year and city.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-5.4-nano · ✗ gpt-6-luna — response contains substituted text (provenance.sanitized), so part of it is not model output

**gpt-5.4-nano** (2306 ms)
1. China-focused results are present, but CO2 reduction attribution is not clearly quantified in the excerpts provided; the bike-sharing study discusses emissions estimation without a specific “kg/ton CO2” figure in the snippet.
2. A “Decarbonizing Road Transport” source appears more sector-strategy than bike-sharing attribution; it may lack direct linkage from bike-sharing volumes to CO2 reductions.
3. Improve the query with keywords like “net CO2 reduction,” “carbon emissions avoided,” “life-cycle emissions,” and request a specific unit (e.g., “annual tons CO2e”) for China.

**gpt-6-luna** (4611 ms) — sanitized: some text was substituted
1. The China-focused bike-sharing report is relevant: it estimates emissions reductions, but the excerpt gives no CO₂ quantity; a Chinese-language publication is also among the results.
2. The most detailed English excerpt reports avoided mortality, not emissions, so the results do not establish how much CO₂ was reduced or the estimate’s timeframe.
3. Refine the query to seek the report’s quantified CO₂ savings, specifying annual versus cumulative reductions and dockless versus public bike-sharing; alignment is Moderate.

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (1712 ms)
1. Sources strongly focus on Chinese dockless bike-sharing’s impacts on daily mobility, with a dedicated WRI-China style report (“How Dockless Bike-Sharing Changes Lives”).
2. Coverage is skewed toward system growth and general effects; travel-behavior mechanisms (mode shift, trip chaining, longer/shorter trips, induced demand) are not clearly evidenced in provided excerpts.
3. All retrieved items are labeled Chinese; potential missing perspectives from other WRI regions or comparative studies (e.g., non-China city contexts) could limit causal interpretation.
4. Improve by narrowing to measurable outcomes: “mode shift,” “first/last mile,” “trip length,” “public transit ridership,” and specifying cities (e.g., Hangzhou, Shanghai, Shenzhen).

**gpt-6-luna** (3398 ms)
1. The Chinese-cities report directly matches the topic, but the excerpts provide little evidence about specific travel-behavior changes; consult its findings and methods before drawing conclusions.
2. Only 2 of 17 results are highly relevant; broader bike-sharing evolution and safety sources may not address dockless systems or behavioral effects in Chinese cities.
3. Results include Chinese-language publications. Refine the query around a city and outcomes such as mode substitution, trip frequency, or transit connections to surface more targeted evidence.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2139 ms)
1. Sources focus on transport decarbonization (mostly road) and explicitly model a “Stated Policy” scenario, but they don’t provide Yantian Port container mode-shift shares or Shenzhen 2035 targets.
2. The only Yantian-specific material is about emissions coverage for domestic transport trips to/from Yantian; it’s not linked to modal share outcomes or port hinterland rail/barge targets.
3. Guangdong road emission studies discuss measure-by-measure decarbonization potential, yet none quantify whether meeting Shenzhen’s 2035 port mode-shift requires “more aggressive than stated policy” action.
4. To improve: narrow the query to “Shenzhen Master Plan 2035 mode shift Yantian port container rail barge share” and “scenario analysis rail intermodal stated policy vs accelerated,” and include English/Chinese plan documents and target tables.

**gpt-6-luna** (5627 ms)
1. The Yantian port study is directly relevant, but its excerpt covers domestic trips and excludes international transloading and shipping; it shows no target-attainment or modal-share projections.
2. Road-traffic scenario studies define “Stated_policy” and discuss regional measures, but Guangdong or national findings cannot establish Yantian-specific feasibility; compare port-level baselines, targets, and scenario shares.
3. Results include Chinese-language publications; seek the Master Plan’s exact freight mode-shift targets and quantified Yantian scenarios, including rail and waterway capacity and measures beyond stated policy.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2180 ms)
1. Only one source directly names Yantian Port and sets a 2035 target for shifting to rail+water; it provides limited detail on the specific road-to-rail barriers.
2. General barriers to intermodal rail use in China include uncompetitive rail pricing, underdeveloped intermodal services, and limited rail service quality—likely relevant to road-to-rail at Yantian.
3. Guangdong-focused excerpts suggest sea-to-rail/sea-to-water promotion (not road-to-rail) and emphasize infrastructure and HDT decarbonization, implying gaps in supporting facilities and logistics integration.
4. To improve, narrow the query to Yantian Port road-rail intermodal links (hinterland rail access, truck-to-rail transfer yards, terminal handling capacity, pricing/tariffs, scheduling reliability) and include Shenzhen/Guangdong logistics constraints.

**gpt-6-luna** (3673 ms)
1. The Yantian-focused source sets a 2035 goal for rail and water to exceed 50% of throughput, but the excerpt does not identify barriers to reaching it.
2. Broader China evidence points to uncompetitive rail pricing, underdeveloped intermodal services, and limited rail-service quality; these constraints are not confirmed specifically for Yantian.
3. Results include Chinese-language publications; refine the query to distinguish rail-water from road-to-rail and seek Yantian-specific evidence on costs, infrastructure, service capacity, and coordination.

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2357 ms)
1. The retrieved sources are strongly road-focused and discuss electrification and “upstream decarbonization,” but none quantify Yantian Port drayage well-to-wheel CO2 reductions at 95% by 2035.
2. Mode-shift is mentioned generically (“greater degrees of freight mode shift”), yet the results don’t provide comparable rail vs water shift impacts for the port/drayage use case you asked for.
3. Key calculation inputs are missing for your scenario—baseline drayage emissions, truck energy/fuel mix, grid-intensity by year, and assumed duty cycle—so any numeric decline would be speculative.
4. To improve coverage, narrow the query to “Yantian Port drayage electrification 2035 well-to-wheel,” and explicitly request “WRI port decarbonization model” plus “rail shift” and “inland waterway shift” comparisons.

**gpt-6-luna** (4623 ms)
1. The top result directly addresses low-carbon container-port transport and says greater freight mode shift and grid decarbonization are needed, but the excerpt gives no 95%-electrification estimate.
2. No supplied passage quantifies Yantian’s well-to-wheel CO2 reduction or compares rail and water mode-shift scenarios; broader China road-transport studies do not fill that gap.
3. Relevant sources include Chinese publications. Refine the search around Yantian, 2035, 95% drayage electrification, well-to-wheel emissions, and rail-versus-water scenarios; alignment is only partial.

## translate

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2634 ms)
> Heading toward 2035: Research on the Promotion Potential of China’s New Energy Heavy Trucks in Regional and Long‑Haul Transportation Scenarios

This report assesses the potential and policy effects of promoting zero‑emission heavy‑duty trucks (zero‑emission heavy‑duty trucks, abbreviated as ZET) in China from 2024 to 2035 for two scenarios: regional delivery (regional delivery, abbreviated as RD) and long‑haul (long‑haul, abbreviated as LH). The findings show that, under a scenario with no policies, the ZET penetration rate in the RD scenario for vehicle model year 2030 is only about 2%–17%, while the LH scenario remains at an early stage before 2035.

Existing policies can significantly increase regional adoption dominated by battery‑electric prime movers before 2027, but it may decline after subsidies expire. Among strengthened policies, waiving or reducing highway tolls (e.g., 50%) is the most effective measure for increasing penetration. The next most effective actions are accelerating the construction of dedicated high‑power fast‑charging networks for heavy trucks and lowering the cost of overnight charging. With an enhanced package of policies, the RD scenario can achieve penetration rates above 50% during MY2027–2030, and can drive significant growth in the LH scenario during MY2032–2035 (reaching approximately 15%–53% by 2035).

The study indicates that uncertainties related to operations, technology, and electricity‑to‑fuel price dynamics have a major impact. It recommends setting targets by scenario and by vehicle type, cautiously evaluating the fiscal impact of highway toll reductions, prioritizing the improvement of heavy‑truck charging infrastructure, and establishing scenario‑based operational data collection and support mechanisms.

**gpt-6-luna** (3119 ms)
> Driving Toward 2035: A Study of the Potential for Promoting New Energy Heavy-Duty Trucks in China’s Regional and Long-Haul Transport Scenarios

This report assesses the potential and policy effects of promoting zero-emission heavy-duty trucks (ZETs) in China from 2024 to 2035 in regional delivery (RD) and long-haul (LH) scenarios. The findings show that, without policy measures, ZET penetration in the RD scenario would reach only around 2%–17% by model year 2030, while the LH scenario would remain at an early stage through 2035. Existing policies could significantly increase regional adoption—primarily of battery-electric tractors—by 2027, but adoption may decline after subsidies expire. Among stronger policy measures, reducing highway tolls (for example, by 50%) is the most effective at boosting penetration, followed by accelerating the development of dedicated fast-charging networks for heavy-duty trucks and lowering nighttime charging costs. Combining stronger policies could raise penetration in the RD scenario to over 50% during MY2027–2030 and drive substantial growth in the LH scenario during MY2032–2035, reaching around 15%–53% by 2035. The study notes that uncertainty regarding operations, technology, and fuel and electricity prices has a significant impact. It recommends setting targets by scenario and vehicle type, carefully assessing the fiscal impact of toll reductions, prioritizing the development of heavy-duty truck charging infrastructure, and establishing scenario-specific operational data collection and support mechanisms.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (1380 ms)
> Techno-Economic Feasibility Analysis of Zero-Emission Trucks in Urban and Regional Delivery Use Cases: A Case Study of Guangdong Province, China

Battery electric trucks (BETs) in port operations, drayage, and urban delivery reach total cost of ownership (TCO) parity with diesel before MY2025 in Guangdong, China—particularly 42-ton tractor trailers. Fuel-cell trucks achieve parity later, around MY2028–2030. Comprehensive policy packages—tax exemptions, energy incentives, road access privileges, ...

**gpt-6-luna** (2116 ms)
> Techno-Economic Feasibility Analysis of Zero-Emission Trucks in Urban and Regional Delivery Use Cases: A Case Study of Guangdong Province, China Battery electric trucks (BETs) in port operations, drayage, and urban delivery reach total cost of ownership (TCO) parity with diesel before MY2025 in Guangdong, China—particularly 42-ton tractor trailers. Fuel-cell trucks achieve parity later, around MY2028–2030. Comprehensive policy packages—tax exemptions, energy incentives, road access privileges, ...

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2321 ms)
> The key findings are as follows: First, without policy incentives, regional delivery would see a modest ZET market share of 2–17 percent by MY2030, while ZET adoption would remain at a nascent stage for long-haul trucking through MY2035. Battery electric trucks will dominate regional delivery, but for long-haul application, the optimal technological mix is uncertain.
[{"box_2d": [78, 365, 480, 500, "label": "text", "caption": "In both applications, zero-emission tractor trailers are more likely to achieve a wide adoption than zero-emission straight trucks. This is primarily due to a wider cost gap between zero-emission straight trucks and their diesel counterparts, driven by greater payload losses in zero-emission straight trucks. Additionally, diesel straight trucks are generally more energy-efficient and have lower purchase costs than diesel tractor trailers."}]
In terms of technology selection, for regional delivery, battery electric trucks are more cost-competitive than fuel cell electric trucks and are expected to dominate this market segment. For long-haul trucking (particularly for tractor trailers), the optimal technological mix is uncertain.

**gpt-6-luna** (2807 ms)
> The key findings are as follows: First, without policy incentives, ZETs would have a modest market share of 2–17 percent in regional delivery by MY2030, while ZET adoption in long-haul trucking would remain at a nascent stage through MY2035. Battery electric trucks will dominate regional delivery, but the optimal technology mix for long-haul applications is uncertain.[{"box_2d": [78, 365, 480, 500, "label": "text", "caption": "In both applications, zero-emission tractor trailers are more likely to achieve wide adoption than zero-emission straight trucks. This is primarily due to the wider cost gap between zero-emission straight trucks and their diesel counterparts, driven by greater payload losses in zero-emission straight trucks. Additionally, diesel straight trucks are generally more energy-efficient and have lower purchase costs than diesel tractor trailers."}] In terms of technology selection, battery electric trucks are more cost-competitive than fuel cell electric trucks for regional delivery and are expected to dominate this market segment. For long-haul trucking (particularly for tractor trailers), the optimal technology mix is uncertain.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2277 ms)
> Diesel trucks are assumed to retain about 30 percent of their retail price as residual value after first use (Pers. Comm. 2024; Basma et al. 2021). The above assumption likely underestimates ZET residual values (and their cost-competitiveness). Under the above assumption, ZET residual values account for 7–25 percent of their retail price, with particularly low residual values for longer-range BETs in the LH application, where larger battery capacity would typically result in higher resale value. To remedy this problem, we also developed several scenarios with increased ZET residual values to evaluate their impact on ZET adoption (see the subsection below “Scenario analysis and uncertainty analysis”). 28 | WRI.ORG.CN # METHODS OF PROJECTING ZET PAYBACK PERIODS AND MARKET SHARE

The cumulative effect of the above decision variables is reflected in the projected ZETs' payback periods and TCO by application:

- ■ “Payback period” refers to the number of years required to recover the higher capital cost of a ZET compared to a diesel truck through ZETs' operational cost savings. For the RD application, diesel trucks generally have a useful life of seven to 10 years (Pers. Comm. 2024; CATARC 2022). Thus, ZET adoption is deemed feasible when the payback period is within five years (Shenzhen Xieli 2022).

**gpt-6-luna** (2520 ms)
> Diesel trucks are assumed to retain about 30 percent of their retail price as residual value after first use (Pers. Comm. 2024; Basma et al. 2021). This assumption likely underestimates ZET residual values (and their cost-competitiveness). Under this assumption, ZET residual values account for 7–25 percent of their retail price, with particularly low residual values for longer-range BETs in the LH application, where larger battery capacity would typically result in higher resale value. To address this issue, we also developed several scenarios with increased ZET residual values to evaluate their impact on ZET adoption (see the subsection below, “Scenario analysis and uncertainty analysis”).

28 | WRI.ORG.CN

# METHODS OF PROJECTING ZET PAYBACK PERIODS AND MARKET SHARE

The cumulative effect of the above decision variables is reflected in the projected ZET payback periods and TCO by application:

- ■ “Payback period” refers to the number of years required to recover a ZET’s higher capital cost compared to a diesel truck through its operational cost savings. For the RD application, diesel trucks generally have a useful life of seven to 10 years (Pers. Comm. 2024; CATARC 2022). Thus, ZET adoption is deemed feasible when the payback period is within five years (Shenzhen Xieli 2022).

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2286 ms)
> Notes: n = 6,902 Source: Survey results. 22 WRI.org.cn

For short and medium trips, compared with walking and buses (relying on fixed bus schedules), people prefer cycling, as it is time-saving. In most cities, motorized vehicles are overused for short-distance travel. For example, 39.3 percent of car trips are less than 5 kilometers in Beijing (BTI 2016). This means cycling has enormous potential for replacing motorized trips in cities.

Based on the survey results (shown in Table 3-1), depending on the city, 17–45 percent of total dockless bike-sharing kilometers traveled replaced motorized kilometers traveled (including private cars, taxis, ride-hailing, and motorcycles). Moreover, bike-and-ride (combined use of bicycle and public transport for one trip) may also have the potential to replace long-distance private motorized trips. And these impacts, especially in terms of replacing private vehicle travel, may be underestimated, as the questionnaire is designed to understand the trips finished by DBS, rather than the entire travel chain in this report.

Furthermore, according to the results, travelers prefer to use dockless bikes since they believe cycling provides opportunities for health gains, as an environmentally friendly travel mode.

**gpt-6-luna** (2859 ms)
> Notes: n = 6,902 Source: Survey results. 22 WRI.org.cn For short and medium trips, compared with walking and buses (which rely on fixed schedules), people prefer cycling because it saves time. In most cities, motorized vehicles are overused for short-distance travel. For example, 39.3 percent of car trips in Beijing are less than 5 kilometers (BTI 2016). This means cycling has enormous potential to replace motorized trips in cities. Based on the survey results (shown in Table 3-1), depending on the city, 17–45 percent of total kilometers traveled by dockless bike-sharing replaced kilometers traveled by motorized modes (including private cars, taxis, ride-hailing, and motorcycles). Moreover, bike-and-ride (combining bicycle and public transport for one trip) may also have the potential to replace long-distance private motorized trips. These impacts, especially in terms of replacing private vehicle travel, may be underestimated, because the questionnaire in this report was designed to understand trips completed by DBS, rather than the entire travel chain. Furthermore, according to the results, travelers prefer to use dockless bikes because they believe cycling offers opportunities for health gains and is an environmentally friendly mode of travel.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (1612 ms)
> How Dockless Bike Sharing Changes Lives: An Analysis of Chinese Cities

Surveying 8,218 DBS users across 12 Chinese cities, DBS cycling yields net annual mortality avoided of 59,635 among 235 million users. Cycling up to one hour daily is optimal at PM2.5 levels of 50–60 µg/m³; cycling beyond 30 minutes is inadvisable above 160 µg/m³. DBS reduces CO₂ by 4.8 million tonnes annually.

Some 54% of users connect DBS to other modes, with 91% linking to public transit. An estimated 15,556 annual bike fat...

**gpt-6-luna** (1631 ms)
> How Dockless Bike Sharing Changes Lives: An Analysis of Chinese Cities Surveying 8,218 DBS users across 12 Chinese cities, DBS cycling yields net annual mortality avoided of 59,635 among 235 million users. Cycling up to one hour daily is optimal at PM2.5 levels of 50–60µg/m³; cycling beyond 30 minutes is inadvisable above 160µg/m³. DBS reduces CO₂ by 4.8 million tonnes annually. Some 54% of users connect DBS to other modes, with 91% linking to public transit. An estimated 15,556 annual bike fat...

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (1733 ms)
> How do dockless bike-sharing changes lives: an analysis of Chinese cities

Jiang Hui, Song Su, Zou Xuan, Lu Lu

WRI.ORG.CN

Report QR code:

## Authors

Jiang Hui, Deputy Researcher, World Resources Institute (WRI) Beijing Office (United States)  
Song Su, Researcher, World Resources Institute (WRI) Beijing Office (United States)  
Zou Xuan, Intern, World Resources Institute (WRI) Beijing Office (United States)  
Lu Lu, Deputy Researcher, World Resources Institute (WRI) Beijing Office (United States)

This report is supported by the Oak Foundation, the Stephen M. Ross Philanthropies, and the William and Flora Hewlett Foundation.

![img-4.jpeg](img-4.

**gpt-6-luna** (1666 ms)
> # How Dockless Bike-Sharing Changes Lives: An Analysis of Chinese Cities

Jiang Hui, Song Su, Zou Xuan, Lu Lu

WRI.ORG.CN

Report QR code:

## Authors

Jiang Hui, Associate Researcher, World Resources Institute (WRI), China Office

Song Su, Researcher, World Resources Institute (WRI), China Office

Zou Xuan, Intern, World Resources Institute (WRI), China Office

Lu Lu, Associate Researcher, World Resources Institute (WRI), China Office

This report was supported by the Oak Foundation, Stephen M. Ross Philanthropies, and the William and Flora Hewlett Foundation.

![img-4.jpeg](img-4.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2631 ms)
> The emissions scope of the analysis covered all the domestic transportation and distribution trips that originated or ended at Yantian Port, excluding international transloading and shipping and the emissions from port handling equipment. The emissions accounting method we used is a bottom-up activity-based method with data acquired through stakeholder interviews and a literature review. It should be noted that, due to insufficient data availability, we did not evaluate the cost-effectiveness of different optimization measures.

## Research findings and recommendations
The scenario construction revealed that shifting containers to railways and waterways would be so challenging for Yantian Port that it would be difficult for the port to reach the mode shift targets set in the *Master Plan of Shenzhen Port (2035)* without taking aggressive measures. Therefore, we constructed scenarios as follows in this study (Table ES-1):

(1). Enhanced-policy scenario (“Enhanced_policy”): This scenario assumed that Yantian Port will reach the freight mode shift targets outlined in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018). By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution—together, the two modes will account for over 50 percent of the port throughput.

**gpt-6-luna** (2624 ms)
> The emissions scope of the analysis covered all domestic transportation and distribution trips that originated or ended at Yantian Port, excluding international transloading and shipping, as well as emissions from port handling equipment. We used a bottom-up, activity-based method to account for emissions, using data collected through stakeholder interviews and a literature review. Due to insufficient data availability, we did not evaluate the cost-effectiveness of different optimization measures.

## Research findings and recommendations

The scenario construction revealed that shifting containers to railways and waterways would be so challenging for Yantian Port that reaching the mode-shift targets set in the *Master Plan of Shenzhen Port (2035)* would be difficult without aggressive measures. Therefore, we constructed the following scenarios for this study (Table ES-1): (1) Enhanced-policy scenario (“Enhanced_policy”): This scenario assumed that Yantian Port would meet the freight mode-shift targets outlined in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018). By 2035, Yantian Port would rely on railways and waterways for container transportation and distribution, with the two modes together accounting for over 50 percent of port throughput.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2588 ms)
> By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution—together, the two modes will account for over 50 percent of the port throughput. Further, we assumed that battery-electric HDTs will represent 15 percent of fleet penetration by 2035. Since this assumption is conservative, we also analyzed the environmental benefits of having a 95 percent fleet penetration of battery-electric drayage trucks in 2035 in the same scenario. (2). Stated-policy scenario (“Stated_policy”): Because railway construction and expansion of the port’s catchment areas would take years, it would be challenging to shift containers to railways and waterways by 2025. Therefore, this scenario assumed that it is infeasible to reach the freight mode shift targets outlined in the Master Plan of Shenzhen Port (2035) (TPRI 2018) by 2025. Further, given that expansion of the port’s hinterland areas to make railways and waterways more cost-competitive (currently, Yantian Port mostly serves Guangdong Province) has future uncertainties, we assumed that the port will not reach the freight mode shift targets set in the Master Plan of Shenzhen Port (2035) by 2035. In the future, Yantian Port will still heavily depend on roadways for container transportation and distribution. (3).

**gpt-6-luna** (3168 ms)
> By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution, with the two modes together accounting for over 50 percent of port throughput. We further assumed that battery-electric HDTs will account for 15 percent of the fleet by 2035. Because this assumption is conservative, we also analyzed the environmental benefits of a 95 percent fleet penetration rate for battery-electric drayage trucks in 2035 under the same scenario. (2). Stated-policy scenario (“Stated_policy”): Because railway construction and expansion of the port’s catchment areas would take years, shifting containers to railways and waterways by 2025 would be challenging. Therefore, this scenario assumed that the freight mode shift targets set out in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018) would not be achievable by 2025. Further, given the uncertainty surrounding expansion of the port’s hinterland areas to make railways and waterways more cost-competitive (Yantian Port currently serves mostly Guangdong Province), we assumed that the port would not meet the freight mode shift targets set out in the *Master Plan of Shenzhen Port (2035)* by 2035. In the future, Yantian Port will continue to depend heavily on roadways for container transportation and distribution. (3).

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-5.4-nano · ✓ gpt-6-luna

**gpt-5.4-nano** (2153 ms)
> Reducing the remaining carbon emissions would require more aggressive measures such as greater degrees of freight mode shift and upstream decarbonization of grid emissions (see Figure ES-1). Second, although the optimization measures examined in this study have decarbonization potentials, not all measures have air pollution reduction co-benefits. Road-to-rail delivers the largest decarbonization and air pollutant reduction potential among the measures examined in this study. The promotion of battery-electric HDTs could also provide air pollution reduction co-benefits: Zero-emission HDTs representing 95 percent of the drayage truck fleet in 2035 would have the second-largest emission reduction potential, following road-to-rail (see Figure ES-2). Figure ES-1 | Well-to-wheel carbon dioxide emissions in the three policy scenarios Note: CO₂ = carbon dioxide. Source: Authors' calculations. Figure ES-2 | Reduction of well-to-wheel carbon dioxide emissions in Enhanced_policy scenario with 95% battery electric drayage trucks in the fleet by different measures Note: WTW = well-to-wheel; CO₂ = carbon dioxide; HDT = heavy-duty truck; BAU = business as usual. Source: Authors' calculations.

**gpt-6-luna** (2890 ms)
> Reducing the remaining carbon emissions would require more aggressive measures, such as a greater shift in freight modes and upstream decarbonization of grid emissions (see Figure ES-1). Second, although the optimization measures examined in this study have decarbonization potential, not all of them also reduce air pollution. Road-to-rail offers the greatest potential among the measures examined in this study to reduce both carbon emissions and air pollutants. Promoting battery-electric HDTs could also yield air pollution reduction co-benefits: zero-emission HDTs making up 95 percent of the drayage truck fleet in 2035 would have the second-greatest emissions reduction potential, after road-to-rail (see Figure ES-2).

Figure ES-1 | Well-to-wheel carbon dioxide emissions in the three policy scenarios

Note: CO₂ = carbon dioxide. Source: Authors' calculations.

Figure ES-2 | Reduction in well-to-wheel carbon dioxide emissions in the Enhanced_policy scenario with battery-electric drayage trucks making up 95% of the fleet, by measure

Note: WTW = well-to-wheel; CO₂ = carbon dioxide; HDT = heavy-duty truck; BAU = business as usual. Source: Authors' calculations.
