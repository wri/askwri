# Route model sweep: routes-v1

- target: https://qa.askwri-app.org
- models: gpt-6-luna vs gpt-6.1-terra
- max_results: 40
- submodule commit: 1dcbeabc909073c4141e8088cce8b7fef6de243a
- evalset: evalset_answer_02.json
- evalset note: no expert_approved case in evalset_answer_02.json; the first 10 in file order were used
- code version: sha256:17b664cb1cf75724317b95a5c83814add41c7ae5f71797ada671513a4b673394
- checks: 0 of 80 calls failed

No English control case: every case is non-English, so a regression that appears only on English input would not show here.

## Mechanical checks

All 80 calls passed the mechanical checks.

## Acceptance numbers

### batch-why
- gpt-6-luna — calls 10, failed 0, p95 6546 ms (n=10), cost $0.009039 for 10 calls ($0.000904 per call), fast mode priced at 2x list
- gpt-6.1-terra — calls 10, failed 0, p95 9402 ms (n=10), cost $0.083058 for 10 calls ($0.008306 per call), fast mode priced at 2x list
- p95 of gpt-6.1-terra vs gpt-6-luna: +43.6% (6546 ms to 9402 ms)
- cost of gpt-6.1-terra vs gpt-6-luna: +818.9%

### batch-relates
- gpt-6-luna — calls 10, failed 0, p95 7136 ms (n=10), cost $0.004415 for 10 calls ($0.000441 per call)
- gpt-6.1-terra — calls 10, failed 0, p95 15457 ms (n=10), cost $0.043109 for 10 calls ($0.004311 per call)
- p95 of gpt-6.1-terra vs gpt-6-luna: +116.6% (7136 ms to 15457 ms)
- cost of gpt-6.1-terra vs gpt-6-luna: +876.4%

### alignment
- gpt-6-luna — calls 10, failed 0, p95 3088 ms (n=10), cost $0.004523 for 10 calls ($0.000452 per call), fast mode priced at 2x list
- gpt-6.1-terra — calls 10, failed 0, p95 3268 ms (n=10), cost $0.036626 for 10 calls ($0.003663 per call), fast mode priced at 2x list
- p95 of gpt-6.1-terra vs gpt-6-luna: +5.8% (3088 ms to 3268 ms)
- cost of gpt-6.1-terra vs gpt-6-luna: +709.8%

### translate
- gpt-6-luna — calls 10, failed 0, p95 3508 ms (n=10), cost $0.001468 for 10 calls ($0.000147 per call)
- gpt-6.1-terra — calls 10, failed 0, p95 7296 ms (n=10), cost $0.014755 for 10 calls ($0.001476 per call)
- p95 of gpt-6.1-terra vs gpt-6-luna: +108.0% (3508 ms to 7296 ms)
- cost of gpt-6.1-terra vs gpt-6-luna: +905.1%

## batch-why

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (1732 ms)
1. This passage directly addresses zero-emission heavy-duty truck penetration in China through 2035 and gives projected penetration figures for regional delivery under a no-policy scenario, though the excerpt does not include the full set of projections.
2. This passage provides technical assumptions about annual vehicle kilometers traveled for truck types, which may inform the report’s modeling but does not state projected market penetration rates.
3. This passage discusses broader strategies for decarbonizing China’s road transport sector, providing context but no specific heavy-duty truck penetration projection through 2035.

**gpt-6.1-terra** (3305 ms)
1. The passage directly discusses projected penetration of zero-emission heavy-duty trucks in China through 2035, including a 2030 estimate of 2%–17% for regional transport under a no-policy scenario.
2. The passage provides annual mileage assumptions for long-haul trucks used in a study of zero-emission heavy-duty truck adoption, but it does not state a projected penetration rate.
3. The passage discusses measures to improve road freight efficiency in China, providing broader decarbonization context but no heavy-duty truck penetration forecast.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (6174 ms)
1. This study directly examines the techno-economic feasibility of battery-electric trucks in Guangdong, China, and is relevant to comparing their ownership costs with diesel trucks, though the excerpt does not show the results.
2. This passage cites research on electric-vehicle costs and benefits in China, providing general cost context but not a specific heavy-duty truck comparison.
3. The cited study explicitly compares total cost of ownership for battery-electric, fuel-cell, and diesel heavy trucks in China, directly matching the query.
4. This excerpt lists references on vehicle-market modeling and plug-in vehicle choice rather than giving a China-specific battery-electric versus diesel truck TCO comparison.
5. The passage concerns references on consumer-choice modeling and does not provide comparative ownership-cost findings for heavy-duty trucks in China.
6. It discusses barriers to adopting battery-electric and fuel-cell vehicles, which is related background but does not compare truck ownership costs.
7. This excerpt references broader low-carbon transition pathways in China, offering policy context without directly addressing heavy-truck TCO.
8. The study evaluates transport modes serving a Shenzhen port, which may provide freight-decarbonization context but does not state a battery-electric versus diesel truck TCO comparison.
9. This passage identifies a model for estimating China's vehicle stocks, use, emissions, and energy consumption, which is background for transport analysis but not a direct truck-cost comparison.
10. The passage explicitly compares TCO across several types of heavy trucks in Beijing and says some pure battery-electric models can reach parity with diesel counterparts under ideal one-for-one replacement. It directly addresses the cost comparison, though the excerpt does not provide the full figures.
11. This passage indicates that a table compares costs for heavy-duty trucks, but the excerpt only provides definitions and does not reveal whether the comparison is specific to China or its results.
12. The excerpt concerns electric-vehicle categories for Hong Kong and does not provide a China-wide battery-electric versus diesel heavy-truck TCO comparison.
13. This tool compares diesel and battery-electric transit buses, not heavy-duty freight trucks, so it is only tangentially relevant to vehicle ownership-cost methods.
14. The passage discusses electric-bus TCO in other markets, not heavy-duty trucks in China, and therefore offers only general context about comparative ownership costs.
15. This passage reviews TCO studies for electric buses and battery degradation, which may inform cost-analysis concepts but does not address China's heavy-duty trucks.
16. The excerpt appears to show transport-cost data but does not identify a battery-electric versus diesel heavy-duty truck comparison in China.
17. It describes ownership-cost benefits for electric buses in a non-Chinese setting, making it background rather than evidence about Chinese heavy-duty trucks.
18. This passage concerns policies to electrify U.S. school buses, not truck ownership costs in China.
19. The tool compares zero-emission and diesel trucks, but it is designed for Indian fleet operators and does not answer the China-specific comparison.
20. This passage explains TCO for electric auto-rickshaws in Indian cities, a different vehicle class and country, so it is only broadly related to ownership-cost analysis.

**gpt-6.1-terra** (8493 ms)
1. The study concerns the techno-economic feasibility of battery-electric trucks in Guangdong, providing Chinese freight-operation context, although the excerpt gives no cost comparison.
2. This reference list cites a study of electric vehicle costs and benefits in China, but the excerpt does not specifically compare heavy-duty truck ownership costs.
3. The citation identifies a study explicitly comparing total ownership costs of battery-electric and diesel heavy trucks in China, though it does not report the results.
4. The passage is a reference list from a report on zero-emission heavy-duty trucks in China; the visible references do not provide a truck cost comparison.
5. This reference-list excerpt comes from a report on Chinese zero-emission heavy-duty freight, but the visible text does not compare electric and diesel truck costs.
6. The passage notes barriers to adoption of battery-electric and fuel-cell vehicles, providing technology context without comparing heavy-duty truck ownership costs.
7. The cited work concerns China's low-carbon transition pathways, offering broad policy context rather than a heavy-duty truck cost comparison.
8. The study evaluates transport modes serving a Chinese port, a potential heavy-truck application, but the excerpt does not compare electric and diesel ownership costs.
9. The reference describes a China vehicle fleet model covering usage, energy, and emissions, which provides transport context but no electric-versus-diesel truck TCO comparison.
10. The passage says some battery-electric heavy trucks can reach TCO parity with diesel trucks under ideal one-to-one replacement conditions, and identifies the cost categories compared.
11. The excerpt defines heavy-duty trucks, TCO, and Chinese yuan for a scenario analysis, but the visible text does not report a cost comparison.
12. The passage lists vehicle and propulsion categories in a Hong Kong road-transport study, but does not compare electric and diesel heavy-truck ownership costs.
13. The tool compares diesel and battery-electric transit bus fleets in China and other countries, offering a related vehicle-cost comparison rather than one for heavy trucks.
14. The passage reports that electric buses can have lower lifetime costs than diesel buses, including an Indian example, but it does not address Chinese heavy trucks.
15. The passage discusses TCO analysis and battery degradation for electric buses, which is relevant background for electric-vehicle costs but not a Chinese truck comparison.
16. The visible excerpt presents transport emissions data for buses and motorcycles, not ownership costs for electric and diesel heavy trucks.
17. The passage discusses ownership and operating-cost benefits of electric buses, providing a related example outside Chinese heavy-duty trucking.
18. The passage concerns policies and sales projections for US electric school buses, not the ownership costs of heavy trucks in China.
19. The Fi-ZET tool compares zero-emission and diesel trucks financially, making its approach relevant, though it is designed for India rather than China.
20. The passage introduces TCO for electric auto-rickshaws in India, illustrating the concept but not comparing Chinese heavy-duty trucks.

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3465 ms)
1. This passage directly compares projected zero-emission truck adoption in regional delivery and long-haul freight, including market-share estimates and the contrast in their adoption potential.
2. It describes a residual-value assumption used in sensitivity analysis, which may affect projected ZET economics, but the excerpt does not compare regional and long-haul adoption.
3. It identifies barriers to heavy-duty truck adoption, such as technology constraints, late total-cost-of-ownership parity, and limited incentives, providing context for adoption potential without distinguishing the two transport scenarios.
4. It concerns emissions outcomes under different road-transport policy scenarios, offering broader decarbonization context but no explicit comparison of zero-emission truck adoption in regional versus long-haul transport.
5. It explicitly notes that zero-emission freight zones could affect both long-haul and regional-haul transportation, but does not quantify or compare their adoption potential.
6. It discusses how zero-emission truck suitability varies by urban operating conditions and use cases, providing related context but not a regional-versus-long-haul adoption comparison.
7. This excerpt is a reference to interviews with truck dealers and other industry sources in a study of urban and regional delivery feasibility, but it provides no substantive adoption comparison.
8. This excerpt cites industry communications in a study of zero-emission trucks for urban and regional delivery, but it does not state findings about regional versus long-haul adoption potential.
9. It describes financial-input sensitivities in a comparative feasibility tool for zero-emission and conventional trucks, which is relevant background on adoption economics but does not compare transport scenarios.

**gpt-6.1-terra** (4708 ms)
1. This passage directly compares adoption prospects, estimating a 2–17% zero-emission truck market share in regional delivery by model year 2030 without incentives, while indicating that adoption remains nascent in the other scenario. The excerpt is truncated before the full comparison is visible.
2. The assumed 30% residual-value guarantee is a sensitivity-analysis input that could affect estimates of zero-emission truck adoption potential, but the excerpt gives no regional versus long-haul comparison.
3. The passage identifies technology, industry structure, cost parity, and policy barriers to zero-emission heavy-duty truck adoption, providing context for adoption potential.
4. The passage describes road-transport emissions under different policy scenarios in Guangdong, offering decarbonization context rather than a comparison of truck adoption by haul distance.
5. The passage notes that zero-emission freight zones could affect long-haul and regional-haul transport, providing policy context relevant to both scenarios.
6. The passage says battery-electric trucks can meet most urban light-delivery needs and have a cost advantage, while introducing challenges in longer-distance applications. It provides related context but does not quantify regional versus long-haul adoption potential.
7. This excerpt lists consultations with truck dealers and manufacturers for a study of urban and regional zero-emission truck feasibility, but contains no adoption findings.
8. This excerpt lists consultations with dealers and new-energy truck experts for a study of urban and regional delivery, but does not compare adoption potential.
9. The passage explains that a zero-emission truck feasibility tool is sensitive to financial assumptions, which could affect adoption estimates, but it does not discuss regional or long-haul scenarios.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (4090 ms)
1. It discusses residual-value assumptions for diesel and zero-emission trucks, which affect comparative truck economics and payback calculations, but the excerpt does not give payback periods.
2. This study analyzes the economic feasibility of battery electric trucks in Guangdong, but the excerpt does not specify payback periods or a comparison with diesel semi-trucks.
3. It describes a residual-value sensitivity assumption for zero-emission trucks, a factor that can influence payback estimates, but it does not report the periods themselves.
4. It compares battery electric and internal-combustion trucks on total cost of ownership in Guangdong and reports when some uses reach cost parity, but not semi-truck payback periods.
5. It defines payback period as a key metric for comparing zero-emission and combustion trucks, providing relevant methodology but no China-specific semi-truck results.
6. This is a reference-list excerpt about China’s road transport sector and does not provide payback-period figures for electric and diesel semi-trucks.
7. It cites a study specifically comparing battery electric, fuel-cell, and diesel heavy trucks in China, a likely source for the requested comparison, but gives no payback figures in this excerpt.
8. It gives cost differences and distance-related information for electric trucks, including a 49-ton semi-truck, compared with conventional fuel trucks; this is closely relevant to economics but does not clearly state payback periods.
9. It provides background on the development and limitations of electric heavy trucks in China, but does not address payback periods or quantify a comparison with diesel.
10. This excerpt is a bibliography entry about China’s road-transport decarbonization modeling and contains no truck payback-period data.
11. It cites a China-focused total-cost-of-ownership study comparing battery electric and diesel heavy trucks, relevant background for the query, but supplies no payback-period results.
12. It describes diesel-truck use in Chinese container ports and the transition context, but does not give payback periods for battery electric semi-trucks.
13. It notes that uptake of zero-emission heavy trucks may accelerate after reaching total-cost parity with diesel, offering context on adoption economics but no China-specific payback periods.

**gpt-6.1-terra** (4795 ms)
1. It gives an assumed diesel-truck residual value, a factor in comparing ownership costs and payback periods.
2. It introduces a study of battery-electric trucks in Guangdong, providing geographic and vehicle context for the query.
3. It describes a residual-value sensitivity assumption for zero-emission trucks, which can affect their comparative economics.
4. It reports that most battery-electric trucks studied in Guangdong have total-cost advantages over combustion counterparts and reach cost parity before model year 2027, though it does not give payback periods.
5. It defines payback period and identifies it as an output of a tool comparing zero-emission and combustion trucks, but provides no China-specific results.
6. It cites research on electric-vehicle costs and benefits in China, providing related background rather than truck payback figures.
7. It cites a study comparing total ownership costs of battery-electric, fuel-cell, and diesel heavy trucks in China.
8. It compares the total ownership cost of a 49-ton electric semi-tractor with its conventional-fuel counterpart in Beijing, though it does not state a payback period.
9. It discusses battery range, power, and economic challenges for electric trucks in China, providing context for their financial feasibility.
10. It cites a China vehicle-fleet model covering vehicle stocks and usage, which provides general transport-analysis context but no payback comparison.
11. It cites a comparative ownership-cost study of battery-electric, fuel-cell, and diesel heavy trucks in China.
12. It describes reliance on diesel trucks in China's container-port transportation, providing context for potential electric-truck adoption.
13. It discusses expected total-cost parity between zero-emission heavy goods vehicles and diesel vehicles in Hong Kong, but gives no payback periods.

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (6546 ms)
1. This passage discusses how dockless bike-sharing affects travel choices in Chinese cities and may include survey evidence on modes displaced, but the excerpt does not show the specific share.
2. This passage concerns emissions strategies for China's road transport sector, but the excerpt does not address bike-share trip substitution.
3. This passage directly reports that 17%–45% of bike-share trips replaced short-distance motor-vehicle trips in China, which addresses the requested share, though the excerpt truncates the details of the vehicle categories.
4. This passage gives walking and cycling targets in Vietnamese cities and does not provide evidence about Chinese bike-share trips replacing motorized trips.
5. This passage provides context on the scale of bicycle-sharing systems in China, but does not say what trips they replace.
6. This passage describes the rapid growth of dockless bike-sharing in China, providing background but no substitution percentage.
7. This passage provides context on public transport use and policy in China, but does not quantify bike-share trips replacing cars, taxis, or ride-hailing.
8. This passage concerns travel and access indicators in Johannesburg and is unrelated to bike-share trip substitution in China.
9. This passage discusses what ride-hailing must replace to reduce emissions, but it concerns electric ride-hailing in other regions rather than Chinese bike-share trips.
10. This passage concerns transport emissions in Hong Kong and does not address bike-share mode substitution in China.
11. This passage discusses bicycle access to public transport in China, but it does not quantify bike-share trips replacing private cars, taxis, or ride-hailing.
12. This passage lists transport modes for an emissions assessment methodology but gives no bike-share substitution data for China.
13. This passage discusses ride-hailing as a substitute mode in Uganda and India, not the share of Chinese bike-share trips that replace motorized services.
14. This passage concerns public bicycle-sharing implementation in India and offers no relevant substitution share for China.
15. This passage explains how cities assess micromobility's emissions impacts, which is related to trip substitution in general but provides no China-specific share.
16. This passage discusses the environmental effects of ride-sharing trips replacing other modes, not bike-share trips or their substitution share in China.
17. This passage provides general background on shared mobility, including bike sharing, but does not quantify which modes bike-share trips replace in China.
18. This passage concerns settlement and access indicators in Surabaya, with no relevant information about Chinese bike-share trips.
19. This passage describes ride-hailing services generally and does not provide evidence about bike-share trip substitution in China.
20. This passage concerns projections for electric vehicles and taxis in China, but not bike-share trips or their replacement of motorized trips.
21. This passage gives information about motorcycle-taxi and bike-taxi services in Latin America, not bicycle-sharing substitution in China.
22. This passage notes the spread of shared bicycles and growth in car ownership in China, providing relevant context but no percentage of bike-share trips that replace motorized trips.
23. This passage reports travel-mode shares in Guadalajara, not the modes displaced by bike-share in China.
24. This passage discusses commuting choices in Bengaluru and does not address bike-share trip substitution in China.
25. This passage discusses how trip costs are modeled for private and chauffeur-driven cars in India, but gives no relevant bike-share substitution data for China.
26. This passage advocates cycling and public transport in Mexico, but does not quantify bike-share trips replacing cars, taxis, or ride-hailing in China.

**gpt-6.1-terra** (9402 ms)
1. It provides Chinese survey evidence on preferences for cycling on short and medium trips, but the excerpt does not give a car-replacement share.
2. It describes sources for energy and pollution estimates for Chinese passenger transport, providing emissions context rather than a bike-share substitution rate.
3. It reports that 17% to 45% of bike-share trips replaced private-vehicle trips, directly addressing the share of motorized trips displaced in China.
4. It provides walking and cycling commute figures for an international case study, not bike-share substitution rates in China.
5. It illustrates the scale of bike sharing in China through Hangzhou's system, but does not quantify trips replacing cars or taxis.
6. It describes the origin and rapid growth of dockless bike sharing in China, providing context without a trip-substitution percentage.
7. It gives Chinese public-transport ridership figures, providing urban mobility context but no bike-share replacement estimate.
8. It presents Johannesburg household and travel statistics, with no visible evidence on bike-share substitution in China.
9. It discusses whether ride-hailing replaces private vehicle travel, a related substitution question, but does not address Chinese bike-share trips.
10. It describes transport emissions data for Hong Kong, providing related transport context but no bike-share substitution share.
11. It discusses cycling as a last-mile connection to public transport in China, but does not quantify replacement of car or taxi trips.
12. It lists private-car driving categories in an emissions assessment methodology, without providing Chinese bike-share substitution rates.
13. It identifies ride-hailing as a substitute for other travel modes, but concerns different cities and does not quantify bike-share displacement of car trips in China.
14. It discusses the potential for public bicycle sharing in India, offering related context but not an estimate for China.
15. It addresses how cities can assess micromobility's greenhouse-gas impacts, a related question influenced by mode substitution, but gives no Chinese replacement share.
16. It discusses the environmental effects of ride-sharing replacing public transport or walking, illustrating mode substitution but not Chinese bike-share displacement of cars.
17. It describes the growth of shared mobility, including bike sharing, but does not quantify which trips are replaced in China.
18. It presents household statistics for Surabaya and does not visibly address bike-share substitution in China.
19. It explains how ride-hailing services operate, providing background on one mode named in the query but no bike-share substitution estimate.
20. It presents projections for new-energy taxis in China, providing taxi-fleet context rather than the share of trips replaced by bike sharing.
21. It includes motorcycle-taxi and bike-taxi figures in a Latin American transport study, but does not address Chinese bike-share replacement rates.
22. It reports that bike sharing is available in more than 360 Chinese cities alongside rising car ownership, but does not quantify trip substitution.
23. It gives travel mode shares for Guadalajara, including taxis, private vehicles, and bicycles, but not bike-share substitution in China.
24. It discusses commuting mode choices in Bengaluru, providing general travel-behavior context rather than Chinese bike-share replacement shares.
25. It explains how private-car trip costs are estimated in an Indian mobility study, but does not address bike-share substitution in China.
26. It discusses reducing vehicle travel through public transport and cycling in Mexico, a related mode-shift goal without a Chinese bike-share estimate.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (5071 ms)
1. This study examines the impacts of dockless bike-sharing in Chinese cities and mentions emissions reductions, but the excerpt does not provide the amount. It directly concerns the queried topic.
2. This passage describes a China-focused study that estimates emissions reductions from bike-sharing and explains how shared bikes replace short motorized trips. It directly addresses the question, though the excerpt omits the numerical estimate.
3. This passage concerns emissions accounting for China's road-transport modes, but it does not discuss bike-sharing or give a bike-sharing reduction estimate. It provides only broader transport-emissions context.
4. This passage gives examples of bike-sharing systems in China and elsewhere, but provides no information about CO₂ emissions reductions. It is background on the scale of bike-sharing.
5. This passage notes the size of Hangzhou's bike-sharing system but does not quantify its emissions benefits. It provides background about bike-sharing in China.
6. This passage reports modeled emissions reductions for several countries, including China, but does not attribute them specifically to bike-sharing. It offers broader climate-policy context rather than an answer to the query.
7. This passage discusses rising transport CO₂ emissions in Chinese cities but does not address bike-sharing or its emissions-reduction contribution. It provides general context about transport emissions.
8. This passage describes bike-sharing and public-transport integration in Chinese cities, a feature relevant to how shared bikes might replace car trips. It does not provide a CO₂ reduction figure.
9. This passage gives figures about vehicle-related pollutants in Beijing, but does not discuss bike-sharing or CO₂ reductions attributed to it. It is only general urban transport-emissions context.
10. This passage concerns China's transport emissions and mitigation goals, but does not specify the contribution of bike-sharing. It provides broader decarbonization context.
11. This guide addresses methods for accounting for shared-micromobility emissions, which could inform how bike-sharing reductions are measured. It does not give a China-specific reduction amount.
12. This passage concerns transport decarbonization strategies in India rather than bike-sharing in China. It does not answer the query.
13. This passage describes how CO₂ reductions from public bicycle sharing are calculated, but focuses on Indian cities and does not state a China-specific amount. Its calculation approach is related background.
14. This passage discusses China's overall energy-related emissions and reliance on coal, but does not address bike-sharing or its reductions. It provides broad national emissions context.
15. This passage concerns zero-emission trucks in Guangdong, not bike-sharing, and provides no relevant bike-sharing emissions estimate. It is unrelated to the queried reduction.

**gpt-6.1-terra** (5837 ms)
1. This study examines dockless bike-sharing across 12 Chinese cities, providing context for its estimated benefits, though the excerpt does not state a CO2 reduction.
2. The report explicitly discusses emissions reductions from dockless bike-sharing in Chinese cities and notes that some trips replace private motor vehicles. The excerpt does not give a CO2 reduction figure.
3. This passage describes data sources for calculating transport energy consumption and air pollutants in China, providing related methodological context but no bike-sharing estimate.
4. This passage describes the scale of Hangzhou's bike-sharing system, providing context for bike-sharing in China but no emissions reduction estimate.
5. This passage gives the number of bicycles and stations in Hangzhou's bike-sharing system but does not discuss CO2 reductions.
6. This passage reports a modeled 89% reduction by 2050 for China and India, but the excerpt does not attribute that reduction to bike-sharing.
7. This passage describes growth in transport CO2 emissions in Beijing and Shenzhen, providing context for the need for emissions reductions but not a bike-sharing estimate.
8. This passage describes how bike-sharing in Hangzhou and Guangzhou is integrated with public transport payments, but it does not quantify emissions reductions.
9. This passage discusses motor-vehicle pollution in Beijing, providing transport-related environmental context but no bike-sharing CO2 reduction figure.
10. This passage discusses the projected trajectory of China's transport emissions and global climate goals, but not reductions attributable to bike-sharing.
11. This passage explains approaches to greenhouse-gas accounting that could inform an assessment of shared micromobility, but it gives no estimate for bike-sharing in China.
12. This passage discusses more efficient use of vehicle capacity in India, a related transport strategy rather than an estimate of bike-sharing emissions reductions in China.
13. This passage describes a method for calculating CO2 emissions based on avoided car trips in India, which is relevant to bike-sharing assessments but provides no Chinese estimate.
14. This passage provides background on China's energy-related CO2 emissions and coal reliance but does not address bike-sharing reductions.
15. The document concerns zero-emission trucks in China, a related transport decarbonization topic, but the excerpt contains no bike-sharing or CO2 reduction estimate.

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (4585 ms)
1. The report focuses on how dockless bike-sharing changes people’s lives in Chinese cities, making it directly relevant to its effects on travel behavior.
2. This is the title and author information for a report specifically about how dockless bike-sharing affects cities in China; it identifies the relevant source, though the excerpt itself gives no findings.
3. It describes the rapid introduction and growth of dockless bike-sharing in Chinese cities, providing context for how the system could influence travel behavior.
4. It gives the scale of a major Chinese bike-share system, offering background on bicycle sharing in China but not specifically on dockless systems or changes in travel behavior.
5. It reports the size of Hangzhou’s bicycle-sharing system, providing context on the scale of bike sharing in China but not its effects on travel behavior.
6. The excerpt concerns transport energy and emissions calculations rather than bike-sharing or travel behavior, so its connection to the query is weak.
7. It cites a 2017 white paper on shared bikes and urban development, which may provide related evidence, but the passage itself does not describe behavioral effects.
8. It notes the spread of shared bikes across Chinese cities alongside rising car ownership, offering context for how bike-sharing relates to broader urban travel patterns.
9. This passage concerns assumptions about truck-driving patterns and does not address bike-sharing or its effects on travel behavior.
10. It discusses methods for assessing the environmental impacts of shared micromobility, a related topic, but does not explain changes in Chinese travel behavior.
11. The excerpt is about electric-mobility resources and does not address dockless bike-sharing or travel behavior in Chinese cities.
12. It mentions first- and last-mile transportation patterns, which are relevant to how shared mobility can shape journeys, but the excerpt does not specifically discuss Chinese dockless bike-sharing.
13. It describes shared-mobility schemes generally, providing background on the wider mobility context but not on dockless bikes in Chinese cities.
14. It describes the launch of a dockless public bike-sharing system in India, offering a comparison for understanding the technology but not its effects in China.
15. It discusses how cycling schemes relate to mode shares and sustainable mobility, concepts relevant to travel behavior, but it focuses on Mexican cities rather than China.
16. It addresses the safety and space needs of walking and cycling, which can affect whether people choose to cycle, but it does not discuss dockless bike-sharing in China.
17. It concerns traffic management and regional commuting rather than dockless bike-sharing, so it provides little context for the query.

**gpt-6.1-terra** (6293 ms)
1. Introduces dockless bike-sharing and its impact on people's lives, but does not specify changes in travel behavior.
2. Identifies a report on how dockless bike-sharing changes lives in Chinese cities, but provides no findings on travel behavior.
3. Provides background on the emergence and rapid growth of dockless bike-sharing in China, without describing its effects on travel behavior.
4. Describes the scale of Hangzhou's station-based bike-sharing system, providing context for bike-sharing in China rather than dockless usage effects.
5. Provides figures on Hangzhou's station-based bike-sharing system, offering context but no evidence about dockless bike-sharing's effects on travel.
6. Identifies sources for transport energy consumption and emissions data, but does not discuss bike-sharing or travel behavior.
7. Cites a white paper on bike-sharing and urban development, which may be relevant, but the excerpt gives no findings.
8. Notes that bike-sharing is available in more than 360 Chinese cities alongside rising car ownership, providing transport context rather than behavioral effects.
9. Discusses assumptions about urban, rural and highway driving, but does not address bike-sharing or Chinese cities.
10. Discusses assessing the environmental impact of shared micromobility, a related topic, but gives no findings about travel behavior in China.
11. Lists sources on emissions and electric vehicles, but does not address bike-sharing or travel behavior in Chinese cities.
12. Introduces first- and last-mile transportation patterns, which are relevant to urban mobility, but does not discuss dockless bike-sharing or China in the excerpt.
13. Provides general context on the growth of shared mobility, focusing on ride-hailing rather than dockless bike-sharing in China.
14. Describes an Indian city's adoption of dockless bike-sharing and reduced need for stations, offering technology context rather than evidence on Chinese travel behavior.
15. Highlights the importance of existing transport mode shares for sustainable mobility, but does not discuss dockless bike-sharing in Chinese cities.
16. Discusses making walking and cycling safer during COVID-19, providing general cycling context without addressing the query's specific question.
17. Mentions smart traffic management and regional commuting in a climate-policy context, but does not address dockless bike-sharing in China.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3174 ms)
1. This study focuses on Yantian Port’s transport and distribution trips, making it directly relevant to assessing the port’s transport-related emissions and potential mode shifts. The excerpt does not provide the Master Plan targets or forecast results, so it cannot establish whether those targets are achievable.
2. It compares the decarbonization potential of transport measures in Guangdong, which can help identify whether Yantian would need interventions beyond a stated-policy pathway. The excerpt is regional rather than specific to Yantian or Shenzhen’s 2035 mode-shift targets.
3. It defines the Stated Policy scenario and distinguishes it from a structural-change scenario, providing a basis for judging whether meeting the targets would require measures more ambitious than stated policies. It does not, in the excerpt provided, give Yantian-specific results or compare them with the Master Plan targets.
4. It describes how urban density and car ownership trends can affect passenger mode shifts, offering context for the feasibility of transport-mode changes in Shenzhen. It does not address port freight or Yantian’s targets specifically.
5. It describes push-and-pull policies for shifting urban travel toward public and rail transport and away from cars, illustrating measures that could support mode-shift goals. Its focus is passenger travel rather than freight at Yantian Port, and it does not assess target feasibility.
6. It concerns how local governments cover sustainable transportation planning and emissions-reduction targets in policy, which can help contextualize Shenzhen’s planning commitments. The excerpt does not provide details on Yantian, the 2035 mode-shift targets, or whether stated policies are sufficient.

**gpt-6.1-terra** (3823 ms)
1. This passage identifies the scope of a study of domestic trips to and from Yantian Port, providing context for assessing its freight transport system. The excerpt does not state mode-shift results or compare them with the Master Plan targets.
2. This passage discusses how transport decarbonization measures vary in effectiveness across regions, but it does not address Yantian Port's mode-shift targets.
3. This passage defines a Stated Policy scenario based on announced national policies and industry intentions, providing context for the query's policy-trajectory comparison. It does not assess Yantian Port or Shenzhen's targets.
4. This passage discusses reversing a passenger mode shift toward private cars in Chinese cities, offering general transport mode-shift context rather than evidence about port freight.
5. This passage describes push-and-pull measures to shift urban passengers from cars to public transport, illustrating more active mode-shift policies, though not for port freight.
6. This passage identifies sustainable transportation plans and emission-reduction targets as categories for assessing local climate policy, but it does not address Shenzhen's specific targets or Yantian Port.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2240 ms)
1. This passage directly discusses Yantian Port’s planned shift toward rail and water transport, providing the relevant expansion goal. The excerpt is truncated, so it does not reveal the specific barriers.
2. It identifies China-wide obstacles to rail-based intermodal transport: uncompetitive railway pricing, underdeveloped intermodal services, and limited rail service quality. These provide relevant context for barriers at Yantian Port, though they are not stated as port-specific findings.
3. It recommends expanding intermodal freight and investing in intermodal infrastructure, indicating that infrastructure limitations are a relevant issue. It does not specify particular barriers at Yantian Port.
4. It directly recommends promoting sea-to-rail and sea-to-water intermodal services at Shenzhen Port, which is relevant to expanding these modes at Yantian. The excerpt gives a policy direction but does not identify the barriers to implementation.

**gpt-6.1-terra** (2539 ms)
1. The passage describes Yantian Port's goal for rail and waterways to carry over half of its container throughput by 2035, providing context for the proposed expansion but not identifying barriers.
2. The passage identifies uncompetitive railway pricing, underdeveloped intermodal services, and limited rail service quality as barriers in China, though it does not specifically discuss Yantian Port.
3. The passage recommends shifting freight from road to rail and water and investing in intermodal infrastructure, which relates to the infrastructure needed for expansion but does not identify Yantian-specific barriers.
4. The passage recommends promoting sea-to-rail and sea-to-water services at Shenzhen port, providing local policy context but not explaining the barriers to expansion at Yantian.

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (5558 ms)
1. This Shenzhen Port case study directly addresses port decarbonization and compares further emissions reductions from freight mode shifts and cleaner electricity, which is relevant to the Yantian truck-electrification estimate and its comparison with rail and water measures. The excerpt does not provide the requested 95%-by-2035 figures.
2. This passage provides national road-transport decarbonization context, but it does not specify Yantian Port, drayage electrification, or rail and water mode-shift reductions.
3. The passage discusses the need for structural changes and vehicle electrification in China’s transport decarbonization, offering relevant policy context. It does not give the port-specific emissions estimate or mode-shift comparison asked for.
4. This report concerns policies to accelerate zero-emission heavy-duty trucks in China and may provide context for truck electrification timelines. The excerpt does not state Yantian-specific well-to-wheel reductions or compare them with rail and water measures.
5. This study provides broad context on China’s road-transport emissions and the limits of relying on vehicle electrification alone. It does not quantify the Yantian Port scenario or the requested mode-shift comparison.
6. This passage concerns Hong Kong road-transport decarbonization recommendations, not Yantian Port’s drayage trucks or freight mode-shift emissions. It offers only general regional context.
7. This passage mentions port low-carbon initiatives and vehicle electrification targets in Chinese transport policy, giving some relevant background. It does not quantify Yantian drayage emissions or compare rail and water shifts.
8. This global transport target discusses green fuels and energy reduction across modes, providing broad decarbonization context. It does not address Yantian Port or the specified truck-electrification and mode-shift reductions.
9. This passage reports how public transport appears in national climate commitments and is not about port freight, drayage trucks, or rail and water mode shifts. Its relevance is minimal background on transport policy.
10. This India-focused scenario analysis concerns transport electrification but not China or Yantian Port. It does not answer the port-specific well-to-wheel emissions question.
11. This passage links emissions reductions to freight-rail electrification and transport mode share, making it relevant to the rail comparison in the query. It does not provide Yantian-specific figures or address the water-shift comparison in detail.
12. This Guangdong zero-emission truck feasibility study offers regional context on truck technologies, but the excerpt contains no Yantian Port emissions estimates or rail and water mode-shift comparison.
13. This passage describes shifting freight from trucks to rail, directly relating to one of the query’s mode-shift measures. It does not provide estimates for Yantian Port or compare rail reductions with water shifts and truck electrification.
14. This Guangdong truck feasibility study provides background on zero-emission vehicle costs and lifetimes, but does not address port emissions reductions or freight mode shifts.
15. This passage recommends zero-emission logistics vehicles in cities within the Pearl River Delta, giving regional policy context for truck electrification. It does not quantify Yantian Port’s well-to-wheel reductions or compare electrification with rail and water shifts.

**gpt-6.1-terra** (6373 ms)
1. This Shenzhen Port study discusses freight mode shifts and grid decarbonization as measures to reduce remaining emissions, providing context for the comparison. The excerpt does not give the requested figures.
2. This study provides national context on road transport emissions and decarbonization timelines, but does not address Yantian Port or the requested comparison.
3. The passage identifies vehicle electrification and structural changes as important to China's transport decarbonization, without quantifying their effects at Yantian Port.
4. The source concerns zero-emission heavy-duty trucks in China, but this excerpt only lists abbreviations and does not provide emissions estimates.
5. The passage provides national context on road transport emissions and notes that electrification alone is insufficient for net zero. It does not quantify port drayage or mode-shift impacts.
6. This passage concerns transport decarbonization in Hong Kong, but the excerpt discusses savings and public transit rather than port freight emissions.
7. The passage describes low-carbon port energy measures and vehicle electrification targets in China, but not Yantian's drayage emissions or freight mode shifts.
8. The passage proposes global transport fuel and energy-consumption targets for 2035, providing broad context but no Yantian-specific estimates.
9. The excerpt concerns public transport in national climate commitments and does not address drayage electrification or freight mode shifts.
10. The passage introduces a table on emissions reductions from electrification in India's transport sector, but provides neither the figures nor a Yantian Port comparison.
11. The passage discusses freight rail electrification and the additional emissions benefits of grid modernization, which are relevant to rail measures but not quantified for Yantian.
12. The source concerns zero-emission trucks in Guangdong, but this excerpt contains a fragment of a chart and a vehicle-life assumption rather than emissions results.
13. The passage describes shifting freight from trucks to rail, a measure relevant to the query's comparison, but provides no Yantian-specific emissions estimate.
14. The passage gives vehicle useful-life assumptions for a Guangdong zero-emission truck study, but does not report the requested emissions reductions.
15. The passage recommends promoting zero-emission logistics vehicles in Guangdong cities, providing regional policy context but no port-specific emissions comparison.

## batch-relates

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2104 ms)
1. Projects zero-emission truck penetration at 15%–53% for long-haul freight in 2035 under strengthened policies, with regional penetration exceeding 50% earlier.
2. Provides technical assumptions from the 2035 heavy-duty truck study but no market penetration projections.
3. Discusses low-carbon vehicle deployment in China’s transport sector without specifying heavy-duty truck penetration through 2035.

**gpt-6.1-terra** (4539 ms)
1. Projects regional penetration above 50% in 2027–2030 and long-haul penetration of 15%–53% by 2035 under strengthened policies.
2. Lists vehicle mileage assumptions and technology abbreviations from the report but gives no penetration projections.
3. Discusses China's low-carbon vehicle transition and freight efficiency without providing heavy-duty truck penetration projections.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (5903 ms)
1. Finds battery-electric trucks in Guangdong can reach TCO parity with diesel before 2025, especially 42-ton tractors.
2. Discusses China’s road-transport decarbonization but provides no truck TCO comparison in the snippet.
3. Cites a study directly comparing Chinese heavy-truck TCO for battery-electric, fuel-cell, and diesel models.
4. Addresses zero-emission heavy-truck policy in China, but the snippet gives no TCO comparison.
5. References research comparing Chinese battery-electric and diesel heavy-truck ownership costs, without stating results.
6. Notes studies of Chinese battery-electric truck TCO parity, but gives no comparative cost figures or timing.
7. Covers China’s transport decarbonization strategies but provides no truck TCO comparison in the snippet.
8. Examines battery-electric heavy trucks versus diesel at Shenzhen port, including TCO as a factor, without results.
9. References a study comparing battery-electric, fuel-cell, and diesel heavy-truck TCO in China, but gives no findings.
10. Compares heavy-truck TCO in Beijing and reports some battery-electric models can reach parity with diesel under ideal replacement.
11. Discusses zero-emission freight-zone scenarios and TCO terminology, without comparing electric and diesel truck ownership costs.
12. Concerns Hong Kong road decarbonization and mentions TCO, but not China truck cost comparisons.
13. Compares bus ownership costs across technologies, not heavy-duty trucks in China.
14. Discusses electric-bus TCO outside China, not battery-electric versus diesel heavy trucks.
15. Analyzes electric-bus TCO and battery replacement, not heavy-duty truck costs in China.
16. Provides China transport emissions methodology rather than truck TCO comparisons.
17. Discusses electric-bus ownership costs in multiple cities, not Chinese heavy-truck TCO.
18. Examines electric versus diesel school-bus TCO in the United States, not Chinese trucks.
19. Provides a truck TCO comparison tool for India, not China.
20. Compares auto-rickshaw ownership costs in India, not heavy-duty trucks.

**gpt-6.1-terra** (11536 ms)
1. Electric trucks in Guangdong port, drayage, and urban delivery applications reach diesel TCO parity before model year 2025.
2. Its references include a study of electric vehicle costs and benefits in China.
3. It cites a dedicated comparison of electric, fuel-cell, and diesel heavy-truck ownership costs in China.
4. Its bibliography concerns vehicle market modeling, including US medium- and heavy-duty vehicles.
5. Its references include medium- and heavy-duty vehicle market modeling and Chinese electric vehicle adoption.
6. It discusses barriers to electrifying heavy-duty vehicles in China, but the cost comparison is truncated.
7. Its references include a study of electric vehicle costs and benefits in China.
8. It identifies relative ownership costs and operational feasibility as factors affecting electric truck adoption at Yantian Port.
9. It cites a dedicated comparison of electric, fuel-cell, and diesel heavy-truck ownership costs in China.
10. Some electric heavy-duty truck types reach diesel TCO parity under an ideal one-for-one replacement scenario in Beijing.
11. It assesses emissions-reduction scenarios involving heavy-duty trucks and defines ownership-cost terminology.
12. It presents a research framework for decarbonizing Hong Kong's road transport, including total ownership costs.
13. Its tool compares ownership costs of electric and diesel buses, including fleets in China.
14. It reports lower ownership costs for electric buses than diesel buses in India, not Chinese trucks.
15. It explains how battery degradation and replacement costs affect electric bus ownership costs.
16. It provides Chinese vehicle emissions factors rather than truck ownership-cost comparisons.
17. It discusses electric bus fuel and maintenance savings compared with conventional buses in Izmir.
18. It identifies an ownership-cost gap between electric and diesel school buses in the United States.
19. Its Indian tool compares electric and diesel trucks' ownership costs and policy sensitivities.
20. It compares purchase and operating costs of electric and combustion auto-rickshaws in India.

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3999 ms)
1. Reports regional ZET shares of 2–17% by 2030 without incentives, while long-haul adoption remains nascent through 2035.
2. Covers policy scenarios and terminology for regional and long-haul trucks but gives no adoption comparison in the snippet.
3. Discusses differing decarbonization timelines across heavy-truck types and duty cycles, without quantifying regional versus long-haul adoption.
4. Assesses zero-emission vehicle decarbonization potential in Guangdong but does not compare regional and long-haul truck adoption.
5. Examines zero-emission freight-zone impacts on regional- and long-haul transport, not their adoption potential.
6. Compares zero-emission truck technologies across urban applications, including long-distance uses, but not regional versus long-haul scenarios.
7. Studies zero-emission trucks in urban and regional delivery, without comparing their adoption potential with long-haul scenarios.
8. Focuses on urban and regional delivery feasibility and does not provide a long-haul adoption comparison.
9. Analyzes single-truck financial feasibility in India, without comparing regional and long-haul adoption scenarios.

**gpt-6.1-terra** (6516 ms)
1. Without incentives, regional adoption reaches 2–17% by 2030, while long-haul adoption remains nascent through 2035.
2. Defines regional and long-haul abbreviations and describes policy sensitivity scenarios, but gives no adoption results.
3. Discusses constraints on heavy-duty electric trucks and differing decarbonization timelines across duty cycles.
4. Identifies zero-emission vehicles as a major emissions reduction measure in Guangdong's decarbonization scenarios.
5. Examines how Beijing zero-emission freight zones could affect regional and long-haul transport.
6. Compares battery-electric and fuel-cell trucks across urban delivery, longer-distance, cold-chain, and heavy-duty applications.
7. Studies urban and regional truck feasibility and cites a paper on regional and long-haul electrification.
8. Studies urban and regional truck feasibility and cites a paper on regional and long-haul electrification.
9. Describes financial assumptions and geographic limitations of an Indian zero-emission truck feasibility tool.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3948 ms)
1. It discusses battery-truck residual values and costs, but gives no payback period versus diesel.
2. It reports when battery trucks reach total-cost parity with diesel in Guangdong, not their payback periods.
3. It examines residual-value assumptions for zero-emission trucks, not comparative payback periods.
4. It describes battery trucks’ total-cost advantages over diesel, but provides no payback periods.
5. It defines payback period for comparing electric and diesel trucks, but its analysis is not specific to China.
6. It concerns China’s transport decarbonization but provides no comparative truck payback-period figures.
7. It cites a China study comparing heavy-truck ownership costs, but gives no payback periods.
8. It gives electric-truck cost gaps and mileage thresholds in Beijing, but not payback periods.
9. It discusses China’s electric-truck development without providing comparative payback periods.
10. It cites a China study on electric and diesel truck ownership costs, but gives no payback periods.
11. It references a China heavy-truck cost comparison, but provides no payback-period results.
12. It examines diesel and low-carbon truck options at Shenzhen port, without reporting payback periods.
13. It discusses when electric trucks may reach diesel cost parity in Hong Kong, not China-specific payback periods.

**gpt-6.1-terra** (9018 ms)
1. Assumed resale values affect the comparative economics of electric and diesel trucks.
2. Electric tractor-trailers reach lifetime cost parity with diesel before model year 2025 in Guangdong.
3. A sensitivity scenario assumes zero-emission trucks retain 30% of their retail price.
4. Most electric trucks reach lifetime cost parity with combustion counterparts before model year 2027 without incentives.
5. Defines payback periods and describes a tool comparing electric and diesel truck profitability in India.
6. Cites research on electric vehicle costs and benefits in China.
7. Cites a study comparing lifetime costs of battery-electric, fuel-cell, and diesel heavy trucks in China.
8. A 49-ton electric tractor costs 105,000 yuan more over its lifetime than its conventional counterpart.
9. Discusses battery limitations and early electric heavy-truck models, including tractor units.
10. Cites a study comparing lifetime costs of electric and diesel heavy trucks in China.
11. Cites a Chinese heavy-truck lifetime cost comparison covering electric and diesel vehicles.
12. Examines measures to reduce reliance on diesel trucks at Shenzhen's Yantian Port.
13. Discusses potential electric heavy-goods vehicle adoption after lifetime cost parity with diesel in Hong Kong.

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (7136 ms)
1. Reports that cycling can replace short-distance motorized trips, but gives no specific share for car, taxi, or ride-hailing.
2. Discusses Chinese transport mode shares and decarbonization, but does not quantify bike-share trips replacing cars, taxis, or ride-hailing.
3. Reports that 17%–45% of Chinese bike-share trips replace private motorized trips, directly addressing the requested share.
4. Covers electric mobility in Vietnamese cities, not the replacement share of bike-share trips in China.
5. Discusses bike sharing in China but provides no share of trips replacing private cars, taxis, or ride-hailing.
6. Describes the growth of dockless bike sharing in China without giving the share replacing motorized trips.
7. Notes bike sharing’s expansion in China but does not quantify trips replacing private motorized modes.
8. Gives travel-mode shares for Johannesburg, unrelated to bike-share trip substitution in China.
9. Discusses what ride-hailing replaces in North America, not bike-share substitution in China.
10. Covers Hong Kong road transport, not the share of Chinese bike-share trips replacing motorized modes.
11. Addresses safe access to public transport in China, but not bike-share trips replacing cars, taxis, or ride-hailing.
12. Lists transport modes for emissions assessment without estimating bike-share trip substitution in China.
13. Discusses ride-hailing as a substitute mode in other regions, not bike-share trip replacement in China.
14. Examines public bicycle sharing in India rather than replacement shares for bike-share trips in China.
15. Offers a method for assessing micromobility impacts but no China-specific substitution share.
16. Discusses possible replacement modes for ride-sharing, not bike-share trips in China.
17. Mentions bike sharing as a shared-mobility option but gives no China-specific motorized-trip replacement share.
18. Provides travel-mode shares for Surabaya, not bike-share substitution in China.
19. Describes dockless bikes as travel alternatives without quantifying their replacement of motorized trips in China.
20. Projects electric vehicle adoption in China, not bike-share trip substitution.
21. Covers informal transport in Latin America, unrelated to bike-share replacement shares in China.
22. Notes bike sharing’s popularity in China but gives no share of trips replacing private motorized modes.
23. Reports travel-mode shares in Guadalajara, not bike-share substitution in China.
24. Examines commuting and transport choices in Bengaluru, not bike-share substitution in China.
25. Studies bus aggregators in India and does not report Chinese bike-share replacement shares.
26. Discusses transport strategies in Mexico, not bike-share trip replacement in China.

**gpt-6.1-terra** (15457 ms)
1. Discusses Chinese cycling's potential to replace short car trips, without providing a replacement share.
2. Shows changes in passenger transport mode shares, including intracity trips in Beijing.
3. Reports that 17%–45% of bike-share trips replace private motor vehicle trips.
4. Reports walking, cycling and electric taxi indicators for Santiago.
5. Describes Hangzhou's large bicycle-share system and potential health benefits.
6. Describes the emergence and growth of dockless bike-sharing in China.
7. Notes that bike-sharing services operate in over 360 Chinese cities.
8. Reports Johannesburg's trip shares by transport mode, including private cars and taxis.
9. Discusses whether electric ride-hailing replaces private vehicle travel or adds trips.
10. Reports registered private cars and taxis in Hong Kong.
11. Discusses cycling safety for last-mile connections to public transport in China.
12. Lists private cars and taxis among vehicle categories for transport emissions assessment.
13. Discusses ride-hailing as a substitute for other travel modes in Uganda and India.
14. Discusses opportunities for public bicycle-sharing in Indian cities.
15. Describes assessing the greenhouse-gas impacts of shared micromobility.
16. Discusses whether on-demand ride-sharing replaces public transport or walking trips.
17. Discusses shared mobility services, including bike-sharing, and their accessibility benefits.
18. Reports transport mode shares in Surabaya, including private cars and two-wheelers.
19. Describes ride-hailing and dockless bikes as alternatives to private vehicles and other modes.
20. Provides projections of new-energy taxi fleets and their share of China's taxis.
21. Discusses informal transport services and motorcycle taxis in Latin America.
22. Notes bike-sharing's availability in over 360 Chinese cities alongside rising car ownership.
23. Reports Guadalajara's trip shares for bicycles, private vehicles, buses and taxis.
24. Discusses commuting mode choices and car use in Bengaluru.
25. Describes trip-cost assumptions for private cars and on-demand taxis in India's capital region.
26. Discusses reducing vehicle trips through public transport, cycling and walking in Mexico.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (4372 ms)
1. Reports that dockless bike-sharing in China reduces CO₂ emissions by 4.8 million tonnes annually.
2. States that bike-sharing in China cuts approximately 4.8 million tonnes of CO₂ each year.
3. Discusses China’s road-transport decarbonization but gives no bike-sharing reduction estimate.
4. Describes Chinese bike-sharing systems without quantifying their CO₂ reductions.
5. Describes China’s bike-sharing systems but does not quantify their CO₂ reductions.
6. Addresses broad national emissions-reduction scenarios, not bike-sharing’s contribution in China.
7. Discusses transport emissions accounting in China without estimating bike-sharing reductions.
8. Covers bike-sharing planning and integration but gives no China-specific CO₂ reduction figure.
9. Discusses transport emissions in China but does not quantify bike-sharing’s CO₂ impact.
10. Examines China’s road-transport emissions rather than bike-sharing’s specific contribution.
11. Provides guidance on assessing shared-micromobility emissions, without a China-specific reduction estimate.
12. Analyzes India’s transport decarbonization, not bike-sharing reductions in China.
13. Discusses Indian public bike-sharing and its emissions calculations, not China’s reduction figure.
14. Addresses China’s urban climate challenges but does not quantify bike-sharing emissions reductions.
15. Analyzes zero-emission trucks in Guangdong, not bike-sharing’s emissions reductions.

**gpt-6.1-terra** (9448 ms)
1. Estimates dockless bike-sharing reduces CO₂ emissions by 4.8 million tonnes annually.
2. Estimates shared bicycles reduce CO₂ emissions by approximately 4.8 million tonnes annually.
3. Discusses Chinese passenger transport mode shares and emission factors, without quantifying bike-sharing reductions.
4. Describes Hangzhou's bike-sharing network and health benefits observed in Barcelona.
5. Describes the size of Hangzhou's bike-sharing network and potential health benefits.
6. Projects an 89% emissions reduction in China and India by 2050, without attributing it to bike-sharing.
7. Discusses rising transport CO₂ emissions in Beijing and Shenzhen and government decarbonization targets.
8. Describes bike-sharing integration with public transit payment systems in Hangzhou and Guangzhou.
9. Discusses transport-related air pollution in Beijing, without quantifying bike-sharing's CO₂ impact.
10. Reports road transport's share of China's transport-related greenhouse gas emissions.
11. Discusses emissions accounting methods relevant to assessing shared micromobility.
12. Discusses shared mobility strategies for reducing transport energy consumption in India.
13. Describes how avoided car-trip CO₂ emissions are estimated for bike-sharing in India.
14. Discusses China's energy-related CO₂ emissions, air pollution and urban congestion.
15. Examines zero-emission delivery trucks in Guangdong rather than bike-sharing reductions.

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (5439 ms)
1. This report directly analyzes how dockless bike-sharing changes travel behavior and lives across Chinese cities.
2. This Chinese-language report directly examines dockless bike-sharing’s effects on urban travel behavior in China.
3. It describes dockless bike-sharing’s rapid growth and spread in Chinese cities, but not its travel-behavior effects.
4. It discusses bicycle-sharing in China generally, not dockless systems’ effects on travel behavior.
5. It describes China’s station-based bike-sharing and general health benefits, not dockless travel behavior.
6. It discusses transport mode shares in China, but the excerpt does not connect changes to dockless bike-sharing.
7. It cites a report on shared bikes and urban development, without explaining their effects on travel behavior.
8. It notes shared-bike services’ broad availability in Chinese cities, but not their effect on travel behavior.
9. It concerns transport emissions and driving patterns, not dockless bike-sharing or travel behavior.
10. It addresses shared micromobility operations and environmental assessment, not travel-behavior effects in China.
11. It focuses on electric mobility in Vietnamese cities, not dockless bike-sharing in China.
12. It discusses first- and last-mile travel solutions generally, without addressing Chinese dockless bike-sharing.
13. It surveys demand-responsive transit and shared mobility, not dockless bike-sharing’s effects in China.
14. It describes an Indian dockless bike-sharing rollout, not travel-behavior effects in Chinese cities.
15. It examines cycling schemes in Mexican cities, not dockless bike-sharing in China.
16. It discusses cycling travel and infrastructure generally, without examining Chinese dockless bike-sharing.
17. It discusses mobility decisions and climate policy, but not dockless bike-sharing’s travel effects in China.

**gpt-6.1-terra** (8608 ms)
1. The report examines dockless bike-sharing in Chinese cities, though the excerpt gives no specific travel-behavior findings.
2. This is the title page of a report on dockless bike-sharing in Chinese cities.
3. Dockless bike-sharing began in China in 2015 and expanded rapidly from campus pilots.
4. Hangzhou's station-based bike-sharing system illustrates the scale of bicycle sharing in China.
5. Hangzhou's station-based system and Barcelona's health findings provide broader bicycle-sharing context.
6. The report includes passenger transport mode-share changes in Beijing and across China.
7. The reference list cites a Mobike white paper on bike-sharing and urban development.
8. Bike-sharing services are available in over 360 Chinese cities, alongside rising car ownership.
9. The methodology uses driving-condition splits for a Chinese city's freight and other vehicles.
10. The guide discusses environmental assessment of docked and dockless shared micromobility operations.
11. The excerpt lists electric-vehicle references, without discussing Chinese bike-sharing.
12. The document discusses first- and last-mile connections to transit hubs, including subsidized shared rides.
13. The document describes shared mobility concepts and ride-hailing growth, rather than bike-sharing in China.
14. An Indian city's dockless system expanded quickly without requiring parking stations.
15. The document recommends considering existing mode shares in sustainable mobility planning in Mexican cities.
16. Cycling grew during the pandemic, prompting cities to expand supporting policies and infrastructure.
17. The document discusses commuting decisions and urban development as factors in transportation energy use.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2848 ms)
1. Analyzes Yantian Port’s transport and distribution emissions, but the snippet does not compare mode-shift targets with stated-policy projections.
2. Compares transport decarbonization measures and mode-shift potential in Shenzhen, offering relevant context but not a Yantian-specific target assessment.
3. Defines stated-policy and stronger structural-change scenarios, clarifying the trajectory comparison but not applying it to Yantian Port.
4. Describes stated-policy green-transport assumptions for major cities, but does not assess Yantian Port’s freight mode shift.
5. Outlines policy tools for shifting urban travel toward public transit, without evaluating freight targets at Yantian Port.
6. Catalogs local sustainable-transport plans and targets, but provides no assessment of Yantian Port’s feasibility or required measures.

**gpt-6.1-terra** (5021 ms)
1. Analyzes emissions from Yantian Port's domestic freight trips but does not evaluate measure cost-effectiveness.
2. Compares regional transport decarbonization measures, including more proactive mode shifts outside Shenzhen.
3. Defines stated-policy and structural-change scenarios, with the latter assuming greater mode shift.
4. Describes national stated-policy assumptions for urban passenger transport, rather than port freight.
5. Outlines push-and-pull policies to shift urban travel from cars to public transport.
6. Identifies sustainable transport plans and emissions targets as criteria for assessing local climate policies.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2025 ms)
1. Projects rail and waterway transport exceeding half of Yantian throughput by 2035, but does not identify expansion barriers.
2. Identifies uncompetitive rail pricing, underdeveloped intermodal services, and poor rail service quality as barriers in China.
3. Recommends infrastructure, equipment, connectivity, pricing, scheduling, and first-/last-mile improvements to support intermodal freight.
4. Recommends promoting sea-to-rail and sea-to-water services at Shenzhen Port, without specifying barriers.

**gpt-6.1-terra** (4886 ms)
1. Projects Yantian’s future reliance on rail and waterways but does not identify expansion barriers.
2. Identifies costly rail pricing, underdeveloped intermodal services, and limited service quality across China, not specifically Yantian.
3. Recommends infrastructure, connectivity, pricing, scheduling, and first- and last-mile improvements for intermodal freight generally.
4. Recommends expanding sea-to-rail and sea-to-water services at Shenzhen port without discussing barriers.

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (4526 ms)
1. The Shenzhen Port case study directly analyzes port decarbonization measures, including drayage electrification and rail and water mode shifts.
2. Discusses national truck electrification and freight mode shifts, but not Yantian Port or the requested comparison.
3. Provides national freight-shift and electrification strategies, without Yantian-specific emissions estimates.
4. Examines zero-emission heavy-duty truck policies, but not port emissions or rail and water mode shifts.
5. Describes truck electrification and road-to-rail or water shifts nationally, without quantifying Yantian Port impacts.
6. Analyzes Hong Kong road transport decarbonization, not Yantian Port drayage or freight mode shifts.
7. Mentions port and freight policies in China, but gives no Yantian electrification emissions comparison.
8. Discusses broad transport decarbonization targets and sustainable mode shifts, not Yantian-specific measures.
9. Focuses on public transport in national climate plans rather than port freight decarbonization.
10. Analyzes Indian transport scenarios, not Yantian Port truck electrification or mode shifts.
11. Supports freight rail and water shifts as emissions measures, but lacks Yantian-specific estimates.
12. Studies zero-emission trucks in Guangdong, but does not compare Yantian electrification with rail and water shifts.
13. Discusses shifting freight from trucks to rail in Mexico, unrelated to Yantian estimates.
14. Examines zero-emission truck feasibility in Guangdong, without the requested Yantian emissions comparison.
15. Recommends zero-emission drayage trucks in Shenzhen and Guangzhou, but does not quantify Yantian port impacts or mode-shift comparisons.

**gpt-6.1-terra** (8305 ms)
1. Evaluates Shenzhen port decarbonization measures and identifies road-to-rail as the largest emissions-reduction opportunity.
2. Models nationwide road transport electrification and freight mode shifts, including their cumulative emissions reductions.
3. Lists national freight mode-share and vehicle electrification targets for carbon neutrality.
4. Examines zero-emission heavy-duty trucks in China, including payload losses.
5. Discusses nationwide truck electrification, freight mode shifts, and power-sector decarbonization.
6. Compares passenger-car electrification scenarios in Hong Kong.
7. Lists provincial targets for port energy use, vehicle electrification, and rail-water freight.
8. Proposes global transport energy and green-fuel targets incorporating electrification and rail shifts.
9. Catalogs public transport and electrification commitments in national climate plans.
10. Models transport electrification and emissions reductions in India.
11. Discusses shifting freight from trucks to rail and water, alongside rail electrification.
12. Analyzes zero-emission truck costs and operational assumptions in Guangdong.
13. Discusses freight shifts from trucks to rail as a transport decarbonization measure in Mexico.
14. Examines zero-emission truck economics in Guangdong, including port operations.
15. Recommends accelerating zero-emission drayage and other heavy-duty trucks in Shenzhen and Guangzhou.

## alignment

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2968 ms)
1. Two highly relevant sources cover China’s regional and long-haul zero-emission heavy-duty trucks, but the excerpts do not provide a projected 2035 penetration rate.
2. The Chinese-language report excerpt gives only a no-policy 2030 regional-delivery estimate of about 2%–17%; it cannot establish the requested 2035 rate or other scenarios.
3. Ask for 2035 estimates by transport segment and policy scenario; retrieved publications include Chinese-language material, while the third result is weakly relevant.

**gpt-6.1-terra** (3019 ms)
1. A Chinese-language report directly models zero-emission heavy-duty truck adoption through 2035 across regional and long-haul transport.
2. The excerpt gives only a 2030 regional-transport projection of 2%–17% without policy; it does not establish the requested 2035 rate.
3. Zero-emission trucks may not cover every vehicle classified as new energy; check definitions and whether penetration refers to sales or the fleet.
4. Search for “China zero-emission heavy-duty truck 2035 sales penetration by policy scenario” and consult the report’s full projections.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2475 ms)
1. Results strongly target China truck costs, including a Guangdong delivery study and a cited battery-electric, fuel-cell, and diesel TCO analysis, but excerpts provide no comparative figures.
2. The evidence may vary by truck duty cycle, route, charging access, and assumptions; policy-focused sources do not necessarily establish ownership-cost comparisons.
3. Relevant sources include publications in Chinese. Refine the query with truck class, operating scenario, comparison period, and desired cost components or study years.

**gpt-6.1-terra** (2833 ms)
1. The Guangdong case study addresses electric truck economics in urban and regional delivery, but its excerpt does not provide a diesel cost comparison.
2. A Chinese-language publication cites a 2021 heavy-truck ownership-cost comparison directly relevant to the query; consult that study for its findings and assumptions.
3. Several highly ranked passages are bibliography entries, not evidence of cost parity. Avoid drawing conclusions from relevance scores alone.
4. Refine the search by truck class, route distance, annual mileage, electricity and diesel prices, and charging costs; include long-haul comparisons beyond Guangdong.

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2648 ms)
1. The China-focused study directly compares regional and long-haul scenarios; its excerpt projects 2–17% regional ZET market share by 2030 without incentives, while long-haul adoption remains nascent.
2. The excerpt does not provide the long-haul share or clarify how adoption compares under policy incentives, so it cannot establish a precise regional-versus-long-haul difference.
3. Relevant sources include Chinese-language publications; narrow the query to China, a target year, and incentive assumptions to retrieve directly comparable adoption figures. Overall, evidence is partial.

**gpt-6.1-terra** (2847 ms)
1. The strongest match estimates regional delivery adoption at 2–17% by model year 2030 without incentives; the excerpt truncates before the long-haul comparison.
2. Relevant publications include Chinese-language sources, but the displayed passages do not establish a numerical difference between regional and long-haul adoption.
3. Other results address broader road decarbonization or freight-zone impacts, so citing them as direct adoption comparisons could mislead.
4. Search for the full China study’s regional and long-haul adoption estimates, specifying model year, policy scenario, and truck technology.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3074 ms)
1. The China truck-policy study is highly relevant, but its excerpt discusses residual values rather than semi-truck payback periods; only one of 13 results is rated highly relevant.
2. The Guangdong study reports battery-truck TCO advantages and parity timing for delivery use cases—not payback versus diesel semi-trucks—so avoid treating those metrics as interchangeable.
3. Relevant sources include Chinese-language publications; refine the query to specify long-haul or tractor-trailer use, payback definition, and assumptions such as mileage, incentives, and energy prices. Results provide partial, not direct, evidence.

**gpt-6.1-terra** (2476 ms)
1. The China heavy-duty truck study and Guangdong delivery case are relevant, but the excerpts do not state electric semi-truck payback periods.
2. Guangdong’s projected total-cost parity before model year 2027 is not a payback period; its delivery use cases may not represent long-haul semis.
3. Residual-value assumptions affect economic comparisons; the financial assessment defines payback but its excerpt does not establish China-specific results.
4. Search for “China electric tractor-trailer diesel payback period” and specify route, annual mileage, electricity prices, incentives, and vehicle purchase year. Results include Chinese-language publications.

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2375 ms)
1. The Chinese-language study reports 17%–45% of bike-share trips replacing private motorized trips, but the excerpt does not isolate cars, taxis, or ride-hailing.
2. A related study reports 54% of rides connect to other modes, 91% of those to public transit; this helps contextualize trip purpose, not the requested replacement share.
3. Only 2 of 26 results are highly relevant, and excerpts omit the estimate’s city, survey, and vehicle-category breakdown; refine for China, specific cities, and car/taxi/ride-hailing substitution.

**gpt-6.1-terra** (3268 ms)
1. A Chinese-language study reports a 17–45% substitution range, but the excerpt cuts off before identifying the modes replaced.
2. The Chinese cities survey is directly relevant, though its excerpt discusses walking and buses rather than providing the requested car, taxi, or ride-hailing shares.
3. Other passages cover transport emissions or bike-share system size, not mode substitution; avoid treating them as evidence for a replacement percentage.
4. Retrieve the full survey tables and search for bike-share mode substitution by city, distinguishing private cars, taxis, and ride-hailing.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2577 ms)
1. The Chinese-city study directly estimates bike-sharing emissions reductions, but the excerpts provide no CO₂ quantity; the mortality figure is not an emissions estimate.
2. Relevant publications include Chinese-language sources, but only 2 of 15 results are rated highly relevant; broader transport and bike-infrastructure results may not quantify bike-sharing impacts.
3. Refine the query to request the study’s estimated annual CO₂ reduction, specifying dockless versus station-based sharing, cities, and reporting period.

**gpt-6.1-terra** (2657 ms)
1. The Chinese-city bike-sharing study estimates emissions benefits using 8,218 surveys across 12 cities, but the excerpts do not report a CO2 reduction figure.
2. A Chinese-language publication discusses avoided motor-vehicle trips; check its full emissions estimate, time period, assumptions, and whether it covers lifecycle emissions.
3. Hangzhou fleet statistics and the road-transport decarbonization report provide context, not a direct estimate of bike-sharing emissions reductions.
4. Search for “China dockless bike-sharing annual CO2 emissions reduction study 12 cities” and specify whether national or city-level estimates are needed.

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3088 ms)
1. The Chinese-cities report directly matches the question, but the excerpts show its framing rather than evidence about specific travel-behavior changes.
2. Only 2 of 17 results are rated highly relevant; broader bike-sharing and station-based examples may not establish dockless-bike effects.
3. Relevant publications include Chinese-language sources; refine the query around outcomes such as transit connections, car use, trip frequency, or specific cities.
4. Moderate alignment: prioritize findings from the Chinese-cities report and distinguish dockless systems from conventional station-based sharing.

**gpt-6.1-terra** (2361 ms)
1. The Chinese-cities report directly matches the query, but the excerpts provide no findings on travel behavior. Results include publications in Chinese.
2. The two highly relevant entries may be versions of the same report; verify before treating them as independent evidence.
3. The Hangzhou example describes station-based sharing, not dockless systems; the technology overview provides adoption context rather than behavioral effects.
4. Search for specific outcomes such as mode shift, trip frequency, transit connections, and car substitution, alongside named Chinese cities and study dates.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2489 ms)
1. A highly relevant Yantian Port study covers domestic trips starting or ending there, but the excerpt provides no mode-shift targets or forecast against Shenzhen’s 2035 plan.
2. Chinese-language Guangdong and national road-transport studies discuss policy scenarios and regional measures, but their broader scope does not establish Yantian-specific feasibility.
3. Evidence is therefore partial: compare port-level baseline and projected mode shares with the plan’s targets, including the stated-policy case and stronger interventions such as freight rail or zero-emission vehicles.

**gpt-6.1-terra** (2439 ms)
1. The Yantian study is directly relevant, but the excerpt gives no mode-shift targets or scenario results; it excludes international transshipment and shipping.
2. The stated-policy scenario describes national road-transport policies, not necessarily Yantian’s port trajectory; other excerpts focus on regional emissions or passenger travel.
3. Retrieve the Master Plan’s 2035 freight-mode targets and the Yantian study’s scenario projections, assumptions, and measures to assess whether stated policies suffice.
4. Relevant results include Chinese-language publications; the excerpts alone cannot establish whether more aggressive measures are required.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2210 ms)
1. The Yantian-focused source sets a 2035 goal for rail and waterways to exceed 50% of throughput, but the excerpt does not identify barriers to reaching it.
2. A broader China road-transport source cites uncompetitive rail pricing, underdeveloped intermodal services, and limited rail service quality; these are plausible context, not Yantian-specific findings.
3. Results include Chinese-language publications; refine the query to distinguish road-to-rail from rail-water links and request Yantian-specific constraints such as infrastructure, costs, and service capacity. Evidence alignment is Moderate.

**gpt-6.1-terra** (2432 ms)
1. The Chinese-language Yantian source sets a 2035 rail-and-water throughput target, but the excerpt does not identify barriers to achieving it.
2. National evidence points to uncompetitive rail pricing, underdeveloped intermodal services, and limited rail service quality; these barriers are not established specifically for Yantian.
3. The Guangdong passage recommends intermodal services at Shenzhen port but does not explain implementation obstacles; avoid presenting recommendations as evidence of local barriers.
4. Search for Yantian-specific rail capacity, port connections, terminal handling costs, scheduling, and coordination; clarify whether the focus is road-to-rail or rail-water transport.

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2745 ms)
1. The Chinese-language port study is highly relevant and flags rail/water freight shifts and cleaner grid power, but the excerpt gives no 95%-by-2035 emissions estimate or mode-shift comparison.
2. Only one of 15 results is rated highly relevant; broader China road-transport studies provide context, not Yantian-specific well-to-wheel calculations, so avoid treating them as direct evidence.
3. Search for the Yantian port study’s scenario tables or figures using English terms such as “95% drayage electrification,” “2035,” “well-to-wheel CO2,” and “rail and water mode shift.”

**gpt-6.1-terra** (2566 ms)
1. The port study is the closest match, but its excerpt gives no 2035 emissions reduction or comparison with rail and water mode shifts.
2. The study identifies freight mode shifts and grid decarbonization as complementary measures; avoid attributing a specific reduction to electrification without scenario results.
3. Other results address national road transport rather than Yantian Port, limiting their usefulness for a port-specific comparison. Retrieved publications include Chinese-language sources.
4. Search for the port study’s Figure ES-1 and scenario tables using “Yantian 95% electrification 2035 well-to-wheel rail water emissions.”

## translate

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3508 ms)
> Driving Toward 2035: A Study of the Potential for Promoting New Energy Heavy-Duty Trucks in Regional and Long-Haul Transport Scenarios in China

This report assesses the potential and policy effects of deploying zero-emission heavy-duty trucks (ZETs) in China from 2024 to 2035 in regional delivery (RD) and long-haul (LH) transport scenarios. The findings show that, without policy measures, ZET penetration in the RD scenario will reach only around 2%–17% by model year 2030, while the LH scenario will remain at an early stage through 2035. Existing policies can significantly boost regional adoption—primarily of battery-electric tractors—by 2027, but adoption may decline after subsidies expire. Among enhanced policies, reducing highway tolls (for example, by 50%) is the most effective measure for increasing penetration, followed by accelerating construction of dedicated fast-charging networks for heavy-duty trucks and lowering the cost of nighttime charging. Combining enhanced policies could raise penetration in the RD scenario to more than 50% during MY2027–2030 and drive substantial growth in the LH scenario during MY2032–2035, reaching approximately 15%–53% by 2035. The study notes that operational, technological, and fuel–electricity price uncertainties have a significant impact. It recommends setting targets by scenario and vehicle type, carefully assessing the fiscal implications of toll reductions, prioritizing the development of charging infrastructure for heavy-duty trucks, and establishing scenario-specific operational data collection and support mechanisms.

**gpt-6.1-terra** (7296 ms)
> Driving Toward 2035: A Study of the Deployment Potential of New Energy Heavy-Duty Trucks in Regional and Long-Haul Transport in China

This report assesses the potential for deploying zero-emission heavy-duty trucks (ZETs) in China’s regional delivery (RD) and long-haul (LH) transport operations from 2024 to 2035, as well as the effects of policies to support their deployment. The findings show that, under a no-policy scenario, ZET penetration in RD operations reaches only about 2%—17% by model year 2030, while deployment in LH operations remains at an early stage through 2035. Existing policies can significantly boost regional adoption, primarily of battery-electric tractor units, by 2027, but adoption may decline after subsidies expire. Among strengthened policies, reducing expressway tolls (by 50%, for example) is the most effective measure for increasing penetration, followed by accelerating the construction of a fast-charging network dedicated to heavy-duty trucks and reducing nighttime charging costs. Combining strengthened policies could raise penetration in RD operations above 50% during MY2027—2030 and drive significant growth in LH operations during MY2032—2035 (reaching approximately 15%—53% in 2035). The study identifies substantial effects from uncertainties in operations, technology, and fuel and electricity prices. It recommends setting targets by operating scenario and vehicle type, carefully assessing the fiscal implications of toll reductions, prioritizing improvements to charging infrastructure for heavy-duty trucks, and establishing mechanisms for collecting operational data and providing support by scenario.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (1647 ms)
> Techno-Economic Feasibility Analysis of Zero-Emission Trucks in Urban and Regional Delivery Use Cases: A Case Study of Guangdong Province, China Battery electric trucks (BETs) in port operations, drayage, and urban delivery reach total cost of ownership (TCO) parity with diesel before MY2025 in Guangdong, China—particularly 42-ton tractor trailers. Fuel-cell trucks achieve parity later, around MY2028–2030. Comprehensive policy packages—tax exemptions, energy incentives, road access privileges, ...

**gpt-6.1-terra** (3027 ms)
> Techno-Economic Feasibility Analysis of Zero-Emission Trucks in Urban and Regional Delivery Use Cases: A Case Study of Guangdong Province, China Battery electric trucks (BETs) in port operations, drayage, and urban delivery reach total cost of ownership (TCO) parity with diesel before MY2025 in Guangdong, China—particularly 42-ton tractor trailers. Fuel-cell trucks achieve parity later, around MY2028–2030. Comprehensive policy packages—tax exemptions, energy incentives, road access privileges, ...

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2234 ms)
> The key findings are as follows: First, without policy incentives, regional delivery would see a modest ZET market share of 2–17 percent by MY2030, while ZET adoption would remain at a nascent stage for long-haul trucking through MY2035. Battery electric trucks will dominate regional delivery, but for long-haul application, the optimal technological mix is uncertain.[{"box_2d": [78, 365, 480, 500, "label": "text", "caption": "In both applications, zero-emission tractor trailers are more likely to achieve a wide adoption than zero-emission straight trucks. This is primarily due to a wider cost gap between zero-emission straight trucks and their diesel counterparts, driven by greater payload losses in zero-emission straight trucks. Additionally, diesel straight trucks are generally more energy-efficient and have lower purchase costs than diesel tractor trailers."}] In terms of technology selection, for regional delivery, battery electric trucks are more cost-competitive than fuel cell electric trucks and are expected to dominate this market segment. For long-haul trucking (particularly for tractor trailers), the optimal technological mix is uncertain.

**gpt-6.1-terra** (4251 ms)
> The key findings are as follows: First, without policy incentives, regional delivery would see a modest ZET market share of 2–17 percent by MY2030, while ZET adoption would remain at a nascent stage for long-haul trucking through MY2035. Battery electric trucks will dominate regional delivery, but for long-haul application, the optimal technological mix is uncertain.[{"box_2d": [78, 365, 480, 500, "label": "text", "caption": "In both applications, zero-emission tractor trailers are more likely to achieve a wide adoption than zero-emission straight trucks. This is primarily due to a wider cost gap between zero-emission straight trucks and their diesel counterparts, driven by greater payload losses in zero-emission straight trucks. Additionally, diesel straight trucks are generally more energy-efficient and have lower purchase costs than diesel tractor trailers."}] In terms of technology selection, for regional delivery, battery electric trucks are more cost-competitive than fuel cell electric trucks and are expected to dominate this market segment. For long-haul trucking (particularly for tractor trailers), the optimal technological mix is uncertain.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2544 ms)
> Diesel trucks are assumed to retain about 30 percent of their retail price as residual value after first use (Pers. Comm. 2024; Basma et al. 2021). This assumption likely underestimates ZET residual values (and their cost-competitiveness). Under this assumption, ZET residual values account for 7–25 percent of their retail price, with particularly low residual values for longer-range BETs in the LH application, where larger battery capacity would typically result in a higher resale value. To address this issue, we also developed several scenarios with increased ZET residual values to evaluate their impact on ZET adoption (see the subsection below, “Scenario analysis and uncertainty analysis”).

28 | WRI.ORG.CN

# METHODS OF PROJECTING ZET PAYBACK PERIODS AND MARKET SHARE

The cumulative effect of the above decision variables is reflected in the projected ZET payback periods and TCO by application:

- ■ “Payback period” refers to the number of years required to recover a ZET’s higher capital cost compared with a diesel truck through the ZET’s operational cost savings. For the RD application, diesel trucks generally have a useful life of seven to 10 years (Pers. Comm. 2024; CATARC 2022). Thus, ZET adoption is deemed feasible when the payback period is within five years (Shenzhen Xieli 2022).

**gpt-6.1-terra** (6312 ms)
> Diesel trucks are assumed to retain about 30 percent of their retail price as residual value after first use (Pers. Comm. 2024; Basma et al. 2021). The above assumption likely underestimates ZET residual values (and their cost-competitiveness). Under the above assumption, ZET residual values account for 7–25 percent of their retail price, with particularly low residual values for longer-range BETs in the LH application, where larger battery capacity would typically result in higher resale value. To remedy this problem, we also developed several scenarios with increased ZET residual values to evaluate their impact on ZET adoption (see the subsection below “Scenario analysis and uncertainty analysis”). 28 | WRI.ORG.CN # METHODS OF PROJECTING ZET PAYBACK PERIODS AND MARKET SHARE The cumulative effect of the above decision variables is reflected in the projected ZETs' payback periods and TCO by application: - ■ “Payback period” refers to the number of years required to recover the higher capital cost of a ZET compared to a diesel truck through ZETs' operational cost savings. For the RD application, diesel trucks generally have a useful life of seven to 10 years (Pers. Comm. 2024; CATARC 2022). Thus, ZET adoption is deemed feasible when the payback period is within five years (Shenzhen Xieli 2022).

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2910 ms)
> Notes: n = 6,902 Source: Survey results. 22 WRI.org.cn

For short and medium trips, people prefer cycling to walking and buses (which rely on fixed schedules), as cycling saves time. In most cities, motorized vehicles are overused for short-distance travel. For example, 39.3 percent of car trips in Beijing are less than 5 kilometers (BTI 2016). This means cycling has enormous potential to replace motorized trips in cities. Based on the survey results (shown in Table 3-1), depending on the city, 17–45 percent of the total kilometers traveled by dockless bike-sharing users replaced kilometers traveled by motorized vehicles (including private cars, taxis, ride-hailing, and motorcycles). Moreover, bike-and-ride (combining bicycle and public transport for one trip) may also have the potential to replace long-distance trips by private motorized vehicles. These impacts, especially the replacement of private vehicle travel, may be underestimated, as the questionnaire in this report was designed to understand trips completed using DBS, rather than the entire travel chain. Furthermore, according to the results, travelers prefer dockless bikes because they believe cycling offers opportunities for health gains and is an environmentally friendly travel mode.

**gpt-6.1-terra** (6123 ms)
> Notes: n = 6,902 Source: Survey results. 22 WRI.org.cn For short and medium trips, compared with walking and buses (relying on fixed bus schedules), people prefer cycling, as it is time-saving. In most cities, motorized vehicles are overused for short-distance travel. For example, 39.3 percent of car trips are less than 5 kilometers in Beijing (BTI 2016). This means cycling has enormous potential for replacing motorized trips in cities. Based on the survey results (shown in Table 3-1), depending on the city, 17–45 percent of total dockless bike-sharing kilometers traveled replaced motorized kilometers traveled (including private cars, taxis, ride-hailing, and motorcycles). Moreover, bike-and-ride (combined use of bicycle and public transport for one trip) may also have the potential to replace long-distance private motorized trips. And these impacts, especially in terms of replacing private vehicle travel, may be underestimated, as the questionnaire is designed to understand the trips finished by DBS, rather than the entire travel chain in this report. Furthermore, according to the results, travelers prefer to use dockless bikes since they believe cycling provides opportunities for health gains, as an environmentally friendly travel mode.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2022 ms)
> How Dockless Bike Sharing Changes Lives: An Analysis of Chinese Cities Surveying 8,218 DBS users across 12 Chinese cities, DBS cycling yields net annual mortality avoided of 59,635 among 235 million users. Cycling up to one hour daily is optimal at PM2.5 levels of 50–60µg/m³; cycling beyond 30 minutes is inadvisable above 160µg/m³. DBS reduces CO₂ by 4.8 million tonnes annually. Some 54% of users connect DBS to other modes, with 91% linking to public transit. An estimated 15,556 annual bike fat...

**gpt-6.1-terra** (4643 ms)
> How Dockless Bike Sharing Changes Lives: An Analysis of Chinese Cities Surveying 8,218 DBS users across 12 Chinese cities, DBS cycling yields net annual mortality avoided of 59,635 among 235 million users. Cycling up to one hour daily is optimal at PM2.5 levels of 50–60µg/m³; cycling beyond 30 minutes is inadvisable above 160µg/m³. DBS reduces CO₂ by 4.8 million tonnes annually. Some 54% of users connect DBS to other modes, with 91% linking to public transit. An estimated 15,556 annual bike fat...

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (1964 ms)
> # How Dockless Bike-Sharing Changes Lives: An Analysis of Chinese Cities

Jiang Hui, Song Su, Zou Xuan, Lu Lu

WRI.ORG.CN

Report QR code:

## Authors

Jiang Hui, Associate Researcher, World Resources Institute (WRI) China

Song Su, Researcher, World Resources Institute (WRI) China

Zou Xuan, Intern, World Resources Institute (WRI) China

Lu Lu, Associate Researcher, World Resources Institute (WRI) China

This report was supported by the Oak Foundation, Stephen M. Ross Philanthropies, and the William and Flora Hewlett Foundation.

![img-4.jpeg](img-4.

**gpt-6.1-terra** (5109 ms)
> # How Bike-Sharing Affects Cities ## HOW DOCKLESS BIKE-SHARING CHANGES LIVES: AN ANALYSIS OF CHINESE CITIES Jiang Hui Song Su Zou Xuan Lu Lu WRI.ORG.CN Report QR code: ## Authors Jiang Hui, Associate Researcher, World Resources Institute (United States) Beijing Representative Office Song Su, Researcher, World Resources Institute (United States) Beijing Representative Office Zou Xuan, Intern, World Resources Institute (United States) Beijing Representative Office Lu Lu, Associate Researcher, World Resources Institute (United States) Beijing Representative Office This report was supported by the Oak Foundation, Stephen M. Ross Philanthropies, and the William and Flora Hewlett Foundation. ![img-4.jpeg](img-4.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2618 ms)
> The emissions scope of the analysis covered all domestic transportation and distribution trips that originated or ended at Yantian Port, excluding international transloading and shipping and emissions from port handling equipment. The emissions accounting method used was a bottom-up, activity-based approach, with data obtained through stakeholder interviews and a literature review. It should be noted that, due to insufficient data availability, we did not evaluate the cost-effectiveness of different optimization measures.

## Research findings and recommendations

Scenario construction revealed that shifting containers to railways and waterways would be so challenging for Yantian Port that it would be difficult for the port to meet the mode shift targets set out in the *Master Plan of Shenzhen Port (2035)* without taking aggressive measures. Therefore, we constructed the scenarios as follows (Table ES-1): (1) Enhanced-policy scenario (“Enhanced_policy”): This scenario assumed that Yantian Port would meet the freight mode shift targets outlined in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018). By 2035, Yantian Port would rely on railways and waterways for container transportation and distribution, with the two modes together accounting for over 50 percent of port throughput.

**gpt-6.1-terra** (6973 ms)
> The emissions scope of the analysis covered all the domestic transportation and distribution trips that originated or ended at Yantian Port, excluding international transloading and shipping and the emissions from port handling equipment. The emissions accounting method we used is a bottom-up activity-based method with data acquired through stakeholder interviews and a literature review. It should be noted that due to insufficient data availability, we did not evaluate the cost-effectiveness of different optimization measures. ## Research findings and recommendations The scenario construction revealed that shifting containers to railways and waterways would be so challenging for Yantian Port that it would be difficult for the port to reach the mode shift targets set in the *Master Plan of Shenzhen Port (2035)* without taking aggressive measures. Therefore, we constructed scenarios as follows in this study (Table ES-1): (1). Enhanced-policy scenario (“Enhanced_policy”): This scenario assumed that Yantian Port will reach the freight mode shift targets outlined in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018). By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution—together, the two modes will account for over 50 percent of the port throughput.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2606 ms)
> By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution—together, the two modes will account for over 50 percent of the port throughput. Further, we assumed that battery-electric HDTs will represent 15 percent of fleet penetration by 2035. Since this assumption is conservative, we also analyzed the environmental benefits of having a 95 percent fleet penetration of battery-electric drayage trucks in 2035 in the same scenario. (2). Stated-policy scenario (“Stated_policy”): Because railway construction and expansion of the port’s catchment areas would take years, it would be challenging to shift containers to railways and waterways by 2025. Therefore, this scenario assumed that it is infeasible to reach the freight mode shift targets outlined in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018) by 2025. Further, given that expansion of the port’s hinterland areas to make railways and waterways more cost-competitive (currently, Yantian Port mostly serves Guangdong Province) has future uncertainties, we assumed that the port will not reach the freight mode shift targets set in the *Master Plan of Shenzhen Port (2035)* by 2035. In the future, Yantian Port will still heavily depend on roadways for container transportation and distribution. (3).

**gpt-6.1-terra** (7062 ms)
> By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution—together, the two modes will account for over 50 percent of the port throughput. Further, we assumed that battery-electric HDTs will represent 15 percent of fleet penetration by 2035. Since this assumption is conservative, we also analyzed the environmental benefits of having a 95 percent fleet penetration of battery-electric drayage trucks in 2035 in the same scenario. (2). Stated-policy scenario (“Stated_policy”): Because railway construction and expansion of the port’s catchment areas would take years, it would be challenging to shift containers to railways and waterways by 2025. Therefore, this scenario assumed that it is infeasible to reach the freight mode shift targets outlined in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018) by 2025. Further, given that expansion of the port’s hinterland areas to make railways and waterways more cost-competitive (currently, Yantian Port mostly serves Guangdong Province) has future uncertainties, we assumed that the port will not reach the freight mode shift targets set in the *Master Plan of Shenzhen Port (2035)* by 2035. In the future, Yantian Port will still heavily depend on roadways for container transportation and distribution. (3).

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2713 ms)
> Reducing the remaining carbon emissions would require more aggressive measures, such as greater shifts in freight modes and upstream decarbonization of grid emissions (see Figure ES-1). Second, although the optimization measures examined in this study have decarbonization potential, not all of them offer co-benefits in terms of reducing air pollution. Among the measures examined, shifting freight from road to rail has the greatest potential to reduce both carbon emissions and air pollutants. Promoting battery-electric HDTs could also provide air pollution reduction co-benefits: zero-emission HDTs making up 95 percent of the drayage truck fleet in 2035 would have the second-largest emissions reduction potential, after the shift from road to rail (see Figure ES-2).

Figure ES-1 | Well-to-wheel carbon dioxide emissions in the three policy scenarios

Note: CO₂ = carbon dioxide. Source: Authors' calculations.

Figure ES-2 | Reduction of well-to-wheel carbon dioxide emissions in the Enhanced_policy scenario with 95% battery-electric drayage trucks in the fleet, by different measures

Note: WTW = well-to-wheel; CO₂ = carbon dioxide; HDT = heavy-duty truck; BAU = business as usual. Source: Authors' calculations.

**gpt-6.1-terra** (7275 ms)
> Reducing the remaining carbon emissions would require more aggressive measures such as greater degrees of freight mode shift and upstream decarbonization of grid emissions (see Figure ES-1). Second, although the optimization measures examined in this study have decarbonization potentials, not all measures have air pollution reduction co-benefits. Road-to-rail delivers the largest decarbonization and air pollutant reduction potential among the measures examined in this study. The promotion of battery-electric HDTs could also provide air pollution reduction co-benefits: Zero-emission HDTs representing 95 percent of the drayage truck fleet in 2035 would have the second-largest emission reduction potential, following road-to-rail (see Figure ES-2). Figure ES-1 | Well-to-wheel carbon dioxide emissions in the three policy scenarios Note: CO₂ = carbon dioxide. Source: Authors' calculations. Figure ES-2 | Reduction of well-to-wheel carbon dioxide emissions in Enhanced_policy scenario with 95% battery electric drayage trucks in the fleet by different measures Note: WTW = well-to-wheel; CO₂ = carbon dioxide; HDT = heavy-duty truck; BAU = business as usual. Source: Authors' calculations.
