# Route model sweep: routes-v1-post-flip

- target: https://qa.askwri-app.org
- models: gpt-6-luna vs gpt-6.1-terra
- max_results: 40
- submodule commit: 1dcbeabc909073c4141e8088cce8b7fef6de243a
- evalset: evalset_answer_02.json
- evalset note: no expert_approved case in evalset_answer_02.json; the first 10 in file order were used
- code version: sha256:2e6bc1b2f5f570a6ea6940595e8f5983e2909f6fb4cc8eb665a61989b1ca814b
- checks: 0 of 80 calls failed

No English control case: every case is non-English, so a regression that appears only on English input would not show here.

## Mechanical checks

All 80 calls passed the mechanical checks.

## Acceptance numbers

### batch-why
- gpt-6-luna — calls 10, failed 0, p95 5891 ms (n=10), cost $0.008689 for 10 calls ($0.000869 per call), fast mode priced at 2x list
- gpt-6.1-terra — calls 10, failed 0, p95 8025 ms (n=10), cost $0.079918 for 10 calls ($0.007992 per call), fast mode priced at 2x list
- p95 of gpt-6.1-terra vs gpt-6-luna: +36.2% (5891 ms to 8025 ms)
- cost of gpt-6.1-terra vs gpt-6-luna: +819.8%

### batch-relates
- gpt-6-luna — calls 10, failed 0, p95 7329 ms (n=10), cost $0.004347 for 10 calls ($0.000435 per call)
- gpt-6.1-terra — calls 10, failed 0, p95 12886 ms (n=10), cost $0.043229 for 10 calls ($0.004323 per call)
- p95 of gpt-6.1-terra vs gpt-6-luna: +75.8% (7329 ms to 12886 ms)
- cost of gpt-6.1-terra vs gpt-6-luna: +894.5%

### alignment
- gpt-6-luna — calls 10, failed 0, p95 3075 ms (n=10), cost $0.004704 for 10 calls ($0.00047 per call), fast mode priced at 2x list
- gpt-6.1-terra — calls 10, failed 0, p95 4250 ms (n=10), cost $0.036776 for 10 calls ($0.003678 per call), fast mode priced at 2x list
- p95 of gpt-6.1-terra vs gpt-6-luna: +38.2% (3075 ms to 4250 ms)
- cost of gpt-6.1-terra vs gpt-6-luna: +681.8%

### translate
- gpt-6-luna — calls 10, failed 0, p95 3130 ms (n=10), cost $0.001458 for 10 calls ($0.000146 per call)
- gpt-6.1-terra — calls 10, failed 0, p95 8983 ms (n=10), cost $0.014755 for 10 calls ($0.001476 per call)
- p95 of gpt-6.1-terra vs gpt-6-luna: +187.0% (3130 ms to 8983 ms)
- cost of gpt-6.1-terra vs gpt-6-luna: +912.0%

## batch-why

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (1681 ms)
1. This report directly evaluates zero-emission heavy-duty truck adoption in China through 2035 and gives projected penetration rates by freight scenario, including a 2030 range for regional delivery under the no-policy scenario.
2. This passage provides vehicle-use assumptions and abbreviations from the same analysis, but does not state projected market penetration rates.
3. This passage concerns broader strategies for decarbonizing China's road transport, offering related context but no specific heavy-duty truck penetration projection through 2035.

**gpt-6.1-terra** (2776 ms)
1. The passage explicitly assesses the adoption potential of zero-emission heavy-duty trucks in China through 2035 and gives a projected 2030 penetration range of 2%–17% for regional delivery under a no-policy scenario.
2. The passage provides annual distance assumptions and terminology for the truck analysis, offering modeling context but no projected market penetration rate.
3. The passage discusses projections and measures to improve road freight efficiency in China, providing related decarbonization context but no heavy-duty truck penetration forecast.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (5891 ms)
1. The cited study directly compares the total cost of ownership of battery-electric, fuel-cell, and diesel heavy trucks in China, making it directly relevant to the requested comparison.
2. This passage cites research on electric-vehicle costs and benefits in China, which may provide broader cost context, but it does not itself give a heavy-truck TCO comparison.
3. The cited report explicitly analyzes TCO for battery-electric and diesel heavy trucks in China, directly matching the query.
4. The passage is a bibliography listing work on truck markets and plug-in vehicle choice; it provides research context but no China-specific electric-versus-diesel truck TCO results.
5. It references vehicle-market and consumer-choice research, which is related background but does not state comparative TCO findings for Chinese heavy-duty trucks.
6. The passage discusses adoption barriers for battery-electric and fuel-cell vehicles, offering general context about zero-emission technologies rather than a truck TCO comparison in China.
7. This citation concerns low-carbon transition pathways in China, a broader policy context that does not directly report heavy-truck TCO comparisons.
8. The passage describes a low-carbon transportation study for a Shenzhen port, but the excerpt does not provide a battery-electric versus diesel heavy-truck cost comparison.
9. The cited vehicle-fleet model documents estimates of vehicle use, emissions, and energy consumption in China; it may support cost analysis but gives no direct TCO comparison here.
10. This passage reports that, under ideal one-for-one replacement, some types of battery-electric heavy trucks in Beijing can reach TCO parity with diesel trucks, directly addressing the comparison.
11. The passage identifies a table comparing heavy-duty truck TCO, but the excerpt only supplies definitions and does not show whether electric or diesel trucks cost less.
12. This passage concerns vehicle technology categories in Hong Kong, not comparative ownership costs for battery-electric and diesel heavy trucks in China.
13. The tool compares battery-electric and conventional bus costs across several regions, including China, but it concerns transit buses rather than heavy-duty trucks.
14. It summarizes TCO findings for electric buses, not heavy-duty trucks, and the cited evidence is not a China-specific truck comparison.
15. This passage discusses TCO analysis and battery degradation for electric buses, which is related to cost methodology but does not answer the truck comparison.
16. The excerpt presents transport cost-assessment data without establishing a comparison between battery-electric and diesel heavy trucks in China.
17. It describes ownership-cost benefits for electric buses in a city-specific case, offering general context but not a Chinese heavy-truck comparison.
18. This passage concerns U.S. school-bus electrification policy and does not provide relevant TCO evidence for Chinese heavy-duty trucks.
19. The tool compares zero-emission and diesel trucks, but its stated audience and context are India rather than China, so it offers related methodology rather than a direct answer.
20. This passage explains TCO for electric auto-rickshaws in Indian cities, a different vehicle class and country from the one in the query.

**gpt-6.1-terra** (8025 ms)
1. The study concerns the techno-economic feasibility of battery-electric trucks in Guangdong, China, providing context for truck cost comparisons.
2. This reference points to an evaluation of electric vehicle costs and benefits in China, but does not specify heavy-duty trucks or compare them with diesel trucks.
3. This citation identifies a study specifically comparing the total cost of ownership of battery-electric, fuel-cell, and diesel heavy trucks in China.
4. The cited vehicle market and consumer choice models provide background for assessing adoption, but the excerpt does not compare truck ownership costs in China.
5. The references concern medium- and heavy-duty vehicle markets and consumer choice, offering background rather than a China-specific ownership cost comparison.
6. The passage notes barriers to adopting battery-electric and fuel-cell vehicles, providing context for transport electrification but no truck cost comparison.
7. This citation concerns low-carbon transition pathways in China, providing broader decarbonization context rather than a truck ownership cost comparison.
8. The study evaluates freight transport options serving Yantian Port, providing context for freight operations in China but no electric-versus-diesel truck cost comparison.
9. The cited China vehicle fleet model estimates vehicle stocks, usage, emissions, and energy use, which can provide context for transport analysis but not a direct cost comparison.
10. The passage states that some battery-electric heavy trucks could reach total cost parity with diesel trucks under ideal one-for-one replacement conditions, and identifies the cost categories compared.
11. The passage defines total cost of ownership, heavy-duty trucks, and Chinese yuan for an authors' comparison, but the excerpt does not show its results.
12. The excerpt identifies vehicle and powertrain categories in a Hong Kong road decarbonization study, but does not compare ownership costs.
13. The tool compares diesel and battery-electric transit buses in China and other markets, offering a related cost-comparison approach rather than results for heavy-duty trucks.
14. The passage reports an electric-versus-diesel bus ownership cost finding from India, illustrating TCO comparisons but not addressing Chinese heavy-duty trucks.
15. The passage discusses how battery degradation relates to electric-bus total cost of ownership, providing potentially relevant cost context but no Chinese truck comparison.
16. The excerpt presents transport emissions data for gasoline vehicles, providing methodology context but no electric-versus-diesel truck ownership cost comparison.
17. The passage discusses electric-bus operating costs and potential ownership savings, but its example is not about heavy-duty trucks in China.
18. The passage reports projected effects of policies on US electric school bus sales, providing electrification context but no relevant truck cost comparison.
19. The Fi-ZET tool compares zero-emission and diesel trucks on financial measures in India, offering a related comparison method but not China-specific results.
20. The passage introduces total cost of ownership for electric auto-rickshaws in India, providing general TCO context but not a heavy-duty truck comparison.

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3549 ms)
1. It directly compares zero-emission truck adoption potential for regional delivery and long-haul freight, including projected market shares under a no-incentive scenario.
2. It describes a residual-value assumption used in sensitivity analysis, which may affect ZET adoption economics, but it does not state the difference between regional and long-haul potential.
3. It gives background on barriers to heavy-duty truck adoption, including technology constraints, industry fragmentation, delayed cost parity, and limited incentives, but does not compare the two transport scenarios.
4. It concerns road-transport emissions under different policy scenarios, offering broad decarbonization context but no specific comparison of ZET adoption in regional versus long-haul freight.
5. It notes that zero-emission freight zones could affect both long-haul and regional-haul transport, but does not quantify or compare their adoption potential.
6. It discusses how zero-emission truck suitability varies by urban use case, including limits for longer-distance and cold-chain operations, providing context on how operating conditions affect adoption.
7. This passage is a reference list about interviews with truck dealers and other stakeholders; it provides no substantive comparison of regional and long-haul adoption potential.
8. This passage is also a reference list for stakeholder communications and does not provide findings about adoption differences between regional and long-haul transport.
9. It describes financial-input limitations in a tool for comparing ZET and conventional trucks, which is relevant to adoption feasibility generally but not to differences between the transport scenarios.

**gpt-6.1-terra** (3897 ms)
1. It directly compares adoption potential, projecting a 2–17% zero-emission truck market share for regional delivery by 2030 without incentives and nascent adoption in the other scenario, though the excerpt is truncated.
2. It identifies a residual-value guarantee used in sensitivity analysis, a financial assumption that could affect adoption estimates, but gives no regional-versus-long-haul comparison.
3. It describes technology, industry, cost-parity, and policy barriers to heavy-duty truck adoption, providing context for differences between transport scenarios.
4. It presents road transport emissions under different policy scenarios, providing decarbonization context but no visible comparison of truck adoption potential.
5. It discusses how zero-emission freight zones could affect long-haul and regional-haul transport, but does not compare their adoption potential.
6. It says battery-electric trucks can meet most urban light-delivery needs and have cost advantages, while indicating challenges for longer-distance operations. This provides related evidence about how suitability varies by use case.
7. It lists consultations with truck dealers and manufacturers for a study of urban and regional zero-emission truck feasibility, but provides no findings or long-haul comparison.
8. It lists consultations with truck dealers and new-energy truck experts for a regional feasibility study, but provides no adoption results or long-haul comparison.
9. It notes that a zero-emission truck feasibility tool is sensitive to financial assumptions, which is relevant to interpreting adoption estimates but does not compare transport scenarios.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (4132 ms)
1. This passage compares residual-value assumptions for diesel and zero-emission trucks, which can affect their costs and payback calculations, but it does not state the payback periods.
2. The study concerns the economic feasibility of battery electric trucks in Guangdong, China, but the excerpt does not provide payback periods for semi-trucks or a direct comparison with diesel.
3. This passage describes a sensitivity assumption for zero-emission truck residual values, a factor that can influence payback periods, but it gives no payback results.
4. It reports cost advantages and timing of total-cost-of-ownership parity for battery electric trucks in several Chinese use cases, but TCO parity is not the same as a payback period and the excerpt does not specify semi-truck payback versus diesel.
5. This passage defines payback period as an investment break-even measure and identifies it as an output of a truck comparison tool, but it gives no China-specific payback figures.
6. This is a bibliography excerpt with no payback-period findings; it only provides general background references on China’s road transport sector.
7. It cites a study comparing battery electric, fuel-cell, and diesel heavy trucks in China, which is closely related to the query, but the excerpt contains no payback-period numbers.
8. The excerpt gives cost differences and mileage thresholds for electric trucks, including a semi-truck category, relative to conventional trucks in Beijing; these figures may inform economic comparison but do not clearly state payback periods.
9. This passage discusses the development and limitations of electric heavy trucks in China, providing market context but no payback-period comparison with diesel.
10. This is a reference to a China transport-sector modeling document and provides no information about electric semi-truck payback periods.
11. It cites a study directly comparing total ownership costs of battery electric, fuel-cell, and diesel heavy trucks in China, but gives no payback-period results itself.
12. This Shenzhen port study provides context on diesel trucks in Chinese freight operations, but the excerpt does not give comparative payback periods for electric semi-trucks.
13. It notes that zero-emission heavy goods vehicles may gain uptake after reaching TCO parity with diesel, offering general economic context but no China-specific semi-truck payback periods.

**gpt-6.1-terra** (4753 ms)
1. It provides a diesel truck residual-value assumption relevant to comparing lifetime costs, but gives no payback period.
2. It identifies a study of the economic feasibility of battery electric trucks in Guangdong, China, but the excerpt gives no payback figures.
3. It describes a zero-emission truck residual-value sensitivity assumption that can affect financial comparisons, but gives no payback period.
4. It reports total-cost-of-ownership advantages and expected parity before model year 2027 for certain battery electric truck applications in Guangdong, but does not give payback periods.
5. It defines payback period as an output of a tool comparing zero-emission and combustion-engine trucks, but provides no China-specific result.
6. It cites sources on vehicle statistics and electric vehicle costs and benefits in China, providing background rather than truck payback estimates.
7. It cites a study comparing the total cost of ownership of battery electric and diesel heavy trucks in China, but provides no results.
8. It compares the total cost of ownership of a 49-tonne battery electric semi-tractor with its conventional-fuel counterpart in Beijing, reporting a cost gap rather than a payback period.
9. It discusses battery limitations and heavy-truck electrification in China, providing technological context rather than payback estimates.
10. It cites a vehicle fleet model covering vehicle use, emissions, and energy consumption, but provides no electric-versus-diesel payback comparison.
11. It cites a comparative total-cost-of-ownership study of battery electric and diesel heavy trucks in China, but does not state its findings.
12. It identifies diesel truck use in Chinese container-port logistics, providing context for a potential electric truck application but no payback figures.
13. It discusses prospective total-cost parity between electric and diesel heavy goods vehicles in Hong Kong, but gives no payback period.

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (5699 ms)
1. This Chinese bike-share survey passage appears to provide trip-substitution findings, but the excerpt is truncated before the specific share replacing private cars, taxis, or ride-hailing is visible.
2. It discusses decarbonizing China's road transport but does not give bike-share trip substitution rates in the excerpt.
3. This report explicitly states that 17% to 45% of bike-share trips replaced private motorized trips, directly addressing the requested share, though the excerpt cuts off before specifying the exact categories or context.
4. It gives walking and cycling commute targets for Vietnamese cities, not the share of Chinese bike-share trips replacing motorized trips.
5. It provides background on the scale of bicycle sharing in China but no information about what trips bike sharing replaces.
6. It describes the rapid growth of dockless bike sharing in China without reporting which transport modes its trips substitute for.
7. It gives figures on public transit use and policy in China, which is contextual to urban mobility but does not answer the question about car, taxi, or ride-hailing substitution.
8. It concerns travel patterns in Johannesburg and does not provide Chinese bike-share substitution data.
9. It discusses whether ride-hailing replaces private vehicle or other ride-hailing miles, but not whether Chinese bike-share trips replace those modes.
10. It concerns transport emissions in Hong Kong and does not report bike-share trip substitution in China.
11. It discusses bicycle access to public transport in China, not the proportion of bike-share trips that replace car, taxi, or ride-hailing journeys.
12. It lists transport modes for an emissions methodology but provides no Chinese bike-share substitution share.
13. It describes ride-hailing as a substitute mode in other contexts, but does not quantify bike-share trips replacing motorized travel in China.
14. It concerns public bicycle sharing in India rather than China and does not supply the requested substitution share.
15. It explains how cities can assess micromobility emissions and substitution effects, but gives no specific China-wide share for the named modes.
16. It discusses the environmental effect of ride-sharing trips replacing other modes, not the share of Chinese bike-share trips replacing cars, taxis, or ride-hailing.
17. It provides broad context on shared mobility, including bike sharing, but no specific Chinese trip-substitution proportion.
18. It concerns settlement conditions in Surabaya and is unrelated to Chinese bike-share trip substitution.
19. It explains ride-hailing service models but does not address bike-share substitution rates in China.
20. It presents projections for electric vehicles and taxis in China, not the share of bike-share trips replacing taxi or other car journeys.
21. It concerns informal transport modes in Latin America and provides no relevant China bike-share substitution data.
22. It notes the spread of shared bikes and rising car ownership in China, providing background but no proportion of bike-share trips that replace motorized modes.
23. It reports transport mode shares for Guadalajara, not Chinese bike-share trips or their substitutes.
24. It discusses commuting mode choices in Bengaluru and does not quantify Chinese bike-share trip substitution.
25. It concerns bus aggregators and car-trip costs in India, not bike-share substitution in China.
26. It discusses broad transport strategies in Mexico, but does not provide the requested Chinese bike-share substitution share.

**gpt-6.1-terra** (7847 ms)
1. The passage provides survey context about why people choose cycling over walking and buses for short and medium trips in Chinese cities, but does not state the share replacing car or ride-hailing trips.
2. The passage describes data sources for energy use and emissions across transport modes in China, but does not discuss bike-share trip substitution.
3. The passage reports that 17% to 45% of bike-share trips replace private vehicle trips, although the excerpt cuts off before the full list of modes is visible.
4. The passage provides cycling and walking targets and results for cities outside China, offering general mobility context but no bike-share substitution figures.
5. The passage describes the scale of bike sharing in China, including Hangzhou's system, but not which trips it replaces.
6. The passage provides background on the emergence and growth of dockless bike sharing in China, without reporting substitution shares.
7. The passage describes growth in urban rail and bus ridership in China, providing transport context rather than bike-share substitution data.
8. The passage contains Johannesburg household and travel statistics, not evidence about bike-share substitution in China.
9. The passage discusses whether electric ride-hailing replaces private vehicle or conventional ride-hailing travel, but does not address bike-share trips in China.
10. The passage concerns transport emissions data for Hong Kong, not the share of bike-share trips replacing car or ride-hailing trips.
11. The passage discusses cycling as a last-mile mode connecting people to public transport in Chinese cities, but does not quantify replacement of car or ride-hailing trips.
12. The passage lists transport modes and driving contexts for an emissions assessment, including private cars, but provides no bike-share substitution estimates.
13. The passage discusses ride-hailing as a substitute for other travel modes in Kampala and Hyderabad, not bike-share substitution in China.
14. The passage introduces public bicycle sharing in India, providing related international context but no evidence about substitution rates in China.
15. The passage discusses assessing the greenhouse-gas effects of shared micromobility, for which mode substitution matters, but gives no China-specific share.
16. The passage discusses the environmental consequences of ride-sharing replacing public transport or walking, rather than bike sharing replacing car trips in China.
17. The passage notes the growth of shared mobility services, including bike sharing, but does not quantify trips replaced in China.
18. The passage contains household service statistics for Surabaya and does not address bike-share substitution in China.
19. The passage explains how ride-hailing services operate, providing background on one of the modes in the query but no bike-share substitution data.
20. The passage presents projections for electric taxi fleets in China, not the share of taxi trips replaced by bike sharing.
21. The passage includes motorcycle- and bike-taxi figures in a Latin American transport study, but does not address bike-share substitution in China.
22. The passage reports that bike sharing is available in more than 360 Chinese cities alongside rising car ownership, but gives no trip replacement share.
23. The passage provides a travel-mode breakdown for Guadalajara, including bicycles, taxis and private vehicles, but not bike-share substitution in China.
24. The passage discusses income-related commuting choices in Bengaluru, providing general mode-choice context but no China bike-share data.
25. The passage describes assumptions for calculating private-car trip costs in India's National Capital Region, not bike-share substitution in China.
26. The passage discusses shifting travel toward public transport and cycling in Mexico, but does not quantify bike-share substitution in China.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (4080 ms)
1. This study analyzes the environmental effects of dockless bike-sharing in Chinese cities, so it is directly relevant, although the excerpt does not show the amount of CO₂ reduction.
2. The passage explicitly reports that Chinese bike-sharing replaces some short motor-vehicle trips and provides emissions-reduction benefits, making it directly relevant; the excerpt omits the numerical reduction.
3. This passage concerns emissions accounting for China's road transport sector, but it does not address bike-sharing or quantify reductions attributable to it.
4. It gives examples of bike-sharing systems in China and elsewhere, but provides no information about CO₂ emissions reductions.
5. It describes the scale of bike-sharing in China through the Hangzhou system's fleet and stations, but does not quantify any emissions reduction.
6. The passage gives modeled transport-emissions reduction targets for several countries, including China, but does not attribute those reductions to bike-sharing.
7. It provides context on transport CO₂ emissions in Chinese cities, but does not discuss bike-sharing or its emissions-reduction contribution.
8. It mentions bike-sharing integration with public transport in Chinese cities, which is related to travel behavior, but gives no CO₂ reduction estimate.
9. This passage concerns vehicle pollution in Beijing, but it does not address bike-sharing or quantify CO₂ reductions from it.
10. It discusses China's transport emissions and decarbonization needs, but does not identify bike-sharing as a source of reductions or provide a relevant figure.
11. The guide explains how emissions from shared micromobility can be assessed, providing methodological context, but the excerpt gives no China-specific reduction amount.
12. This passage concerns transport decarbonization strategies in India rather than bike-sharing in China, so it does not answer the query.
13. It describes a method for calculating CO₂ emissions avoided by public bicycle-sharing in India, offering related methodological context but no estimate for China.
14. It provides background on China's energy-related emissions, but does not discuss bike-sharing or emissions reductions attributable to it.
15. This passage concerns zero-emission trucks in Guangdong, not bike-sharing, and gives no relevant estimate of bike-sharing's CO₂ reduction.

**gpt-6.1-terra** (6112 ms)
1. The passage describes a large survey of dockless bike-sharing users across Chinese cities, but the excerpt reports health benefits rather than CO2 reductions.
2. The passage explicitly discusses emissions-reduction estimates from bike-sharing in Chinese cities and the replacement of motor vehicle trips, although the excerpt gives no CO2 reduction figure.
3. The passage describes data sources for energy consumption and transport air pollutants, providing methodological context but no bike-sharing CO2 estimate.
4. The passage provides background on the scale of bike-sharing in Hangzhou, China, but does not quantify its emissions impact.
5. The passage gives the number of bikes and stations in Hangzhou's bike-sharing system, providing scale but not an emissions reduction.
6. The passage cites a modeled 89% reduction in China and India by 2050, but the excerpt does not attribute it to bike-sharing.
7. The passage provides context on rising transport CO2 emissions in Beijing and Shenzhen, but does not discuss bike-sharing reductions.
8. The passage describes how bike-sharing integrates with public transport in Hangzhou and Guangzhou, but gives no emissions estimate.
9. The passage discusses motor vehicle pollution in Beijing, providing transport emissions context without quantifying bike-sharing benefits.
10. The passage discusses China's transport emissions trajectory and climate goals, but does not address bike-sharing's contribution.
11. The passage explains approaches to accounting for greenhouse gas emissions, which could inform assessment of shared micromobility, but provides no China-specific reduction figure.
12. The passage concerns transport resource efficiency in India, but the excerpt does not address bike-sharing or emissions reductions in China.
13. The passage describes a method for calculating CO2 savings from bicycle sharing in India, but does not provide an estimate for China.
14. The passage provides background on China's energy-related CO2 emissions and coal reliance, but does not discuss bike-sharing.
15. The source concerns zero-emission trucks in China, while the excerpt describes general partnership activities and provides no bike-sharing emissions data.

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (5440 ms)
1. This report focuses specifically on how dockless bike-sharing changes people’s lives in Chinese cities, making it a direct source on its effects on travel behavior.
2. This is the title and author information for a report about how dockless bike-sharing affects Chinese cities; it identifies a directly relevant source, though the excerpt gives no findings.
3. It describes the introduction and rapid expansion of dockless bike-sharing in China, providing context for how the service could reshape urban travel patterns.
4. It gives the scale of a major Chinese bicycle-sharing system, offering background on the prominence of bike-sharing in Chinese urban transport but not describing behavioral effects.
5. It provides figures on the size and infrastructure of Hangzhou’s bike-sharing system, illustrating the scale of bike-sharing in China without explaining its effects on travel behavior.
6. The excerpt concerns transport energy and emissions data rather than bike-sharing or traveler behavior, so it offers little relevant evidence.
7. It cites a 2017 report on shared bikes and urban development, which may contain relevant evidence, but the passage itself is only a reference.
8. It notes that shared bikes are widespread across Chinese cities, providing context for their place in the broader transport landscape, but does not say how they change travel behavior.
9. This passage concerns assumptions in a tool for estimating truck travel and does not address bike-sharing or its effects on urban travelers.
10. It discusses methods for assessing the environmental impacts of shared micromobility, a related topic, but the excerpt does not describe behavioral effects in Chinese cities.
11. The excerpt is about electric mobility and emissions data, with no stated connection to dockless bike-sharing or travel behavior in China.
12. It mentions first- and last-mile transportation patterns, which are relevant to how shared mobility can affect travel choices, but does not specifically address dockless bikes in China.
13. It discusses shared mobility and ride-hailing rather than dockless bike-sharing, so it provides only broad context about emerging transport services.
14. It describes how dockless public bike-sharing was introduced in an Indian city, offering a comparison on the potential effects of dockless technology, but not evidence about Chinese cities.
15. It discusses how cycling schemes relate to sustainable mobility and mode shares, concepts relevant to travel behavior, but its focus is on Mexican cities rather than dockless bikes in China.
16. It addresses the safety and infrastructure needs of walking and cycling, which can influence whether people choose to cycle, but does not examine dockless bike-sharing in China.
17. The passage concerns smart traffic management and commuting generally, with no specific information about dockless bike-sharing or its effects on travel behavior.

**gpt-6.1-terra** (5772 ms)
1. Introduces dockless bike-sharing and its impact on people’s lives, providing context for the study of Chinese cities.
2. Identifies a report on how dockless bike-sharing changes lives in Chinese cities, but provides no findings on travel behavior.
3. Describes the emergence and rapid growth of dockless bike-sharing in China, providing context for its potential influence on travel.
4. Provides scale and infrastructure details for Hangzhou’s station-based bike-sharing system, offering related Chinese context rather than evidence about dockless travel behavior.
5. Describes the size of Hangzhou’s station-based bike-sharing system and usage of a Mexican system, providing background on bike-sharing.
6. Identifies sources for Chinese transport energy and pollution data, but does not discuss dockless bike-sharing or travel behavior.
7. Cites a 2017 white paper on bike-sharing and urban development that may provide relevant evidence, though the excerpt contains no findings.
8. Notes that bike-sharing services are available in more than 360 Chinese cities and contrasts their growth with rising car ownership.
9. Discusses assumptions about driving patterns in a transport assessment tool, but does not address bike-sharing or Chinese cities.
10. Discusses assessing the life-cycle impacts of shared micromobility, a related topic, but gives no evidence about travel behavior in China.
11. Lists energy and electric-vehicle references but does not address dockless bike-sharing or travel behavior in Chinese cities.
12. Points to first- and last-mile transportation patterns as an urban mobility issue, but does not explain the role of dockless bikes in China.
13. Introduces the growth of shared mobility services, providing broad context but no evidence about dockless cycling in Chinese cities.
14. Explains that dockless technology reduces the need for parking stations in an Indian bike-sharing system, offering relevant technology context outside China.
15. Emphasizes considering existing transport mode shares when promoting sustainable mobility, a relevant framework for assessing travel behavior.
16. Discusses the need for safe walking and cycling space during COVID, providing infrastructure context rather than evidence about bike-sharing behavior.
17. Mentions smart traffic management as a local low-carbon strategy, but does not address dockless bike-sharing or its effects on travel.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3237 ms)
1. This study explicitly analyzes transportation and distribution trips associated with Yantian Port, making its scope relevant to assessing the port’s emissions and transport-mode shifts. The excerpt does not provide the mode-share targets or results needed to determine whether the Master Plan targets are achievable.
2. The passage compares the decarbonization potential of measures across regions, which can help assess what interventions might be needed beyond a stated-policy trajectory. It is not specific to Yantian Port or Shenzhen’s 2035 mode-shift targets.
3. It defines the Stated Policy scenario and contrasts it with a structural-change pathway, providing a useful benchmark for judging whether meeting the targets would require action beyond stated policies. The excerpt does not establish the port-specific feasibility of those targets.
4. It discusses how urban conditions can affect shifts between public and private transport, offering context for whether mode-shift ambitions are realistic. It does not directly address freight movements at Yantian Port or compare them with Shenzhen’s 2035 targets.
5. It describes push-and-pull policies for shifting urban travel toward public and other green transport, illustrating the kinds of measures that can support mode shift. The focus is passenger transport rather than port freight, so it does not directly establish what Yantian needs.
6. It concerns how local governments cover sustainable transportation planning and emissions targets in their climate policies, providing context for evaluating Shenzhen’s policy framework. The excerpt does not indicate Yantian-specific targets, outcomes, or the additional measures needed to meet them.

**gpt-6.1-terra** (3642 ms)
1. This passage identifies the scope of a Yantian Port transportation analysis, providing context for assessing its freight mode shift. The excerpt does not state the targets or whether they can be met.
2. This passage discusses how transport decarbonization potential varies across regions and highlights zero-emission vehicles, but it does not address Yantian Port's mode-shift targets.
3. This passage defines the Stated Policy scenario, helping clarify the trajectory against which more aggressive measures could be compared. It does not assess Yantian Port's targets.
4. This passage discusses passenger mode shifts in Chinese cities, offering broader transport context but not addressing freight transport at Yantian Port.
5. This passage describes push-and-pull policies for shifting passenger travel toward public transport. It provides examples of mode-shift measures, but not for port freight.
6. This passage identifies sustainable transportation plans and emissions targets as categories for assessing local government policy. It does not address Shenzhen's specific port targets or their feasibility.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (1932 ms)
1. It directly describes Yantian Port’s planned shift toward rail and water transport, establishing the expansion goal that the query asks about, though the excerpt does not show the specific barriers.
2. It identifies obstacles to rail-based intermodal freight in China—uncompetitive railway pricing, underdeveloped services, and limited service quality—that help explain barriers relevant to Yantian Port.
3. It discusses tactics for shifting freight to rail and water and investing in intermodal infrastructure, which provides context on the measures needed to address expansion constraints, but does not name Yantian-specific barriers.
4. It recommends promoting sea-to-rail or sea-to-water intermodal services at Shenzhen Port, a relevant regional policy response, but the excerpt does not specify the barriers to expanding them at Yantian.

**gpt-6.1-terra** (2989 ms)
1. It provides a 2035 target for increasing the share of Yantian Port's container traffic carried by rail and water, but does not identify barriers.
2. It identifies uncompetitive rail pricing, underdeveloped intermodal services, and limited rail service quality as barriers in China, though it does not address Yantian specifically.
3. It recommends shifting freight to rail and water and investing in intermodal infrastructure, providing context on potential measures rather than Yantian-specific barriers.
4. It recommends promoting sea-to-rail and sea-to-water services at Shenzhen port, which is relevant to the proposed modal shift but does not identify barriers.

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (5483 ms)
1. This Shenzhen Port case study directly discusses reducing port transportation emissions through freight mode shift and grid decarbonization, which are relevant to comparing drayage electrification with rail and water measures. The excerpt does not provide the requested 95%-by-2035 reduction figure.
2. This passage provides national context on strategies for reducing road-transport emissions in China, including electrification, but it does not address Yantian Port, the specified drayage target, or comparisons with rail and water mode shifts.
3. It highlights vehicle electrification and structural changes as necessary strategies for China's carbon-neutrality goals, offering general context for the query. It does not give the port-specific emissions estimate or mode-shift comparison requested.
4. This source concerns policies to accelerate zero-emission heavy-duty trucks in China, so it is related to truck electrification. The excerpt contains no Yantian Port estimate or comparison with rail and water measures.
5. This passage offers broad evidence that road-vehicle electrification alone is insufficient for achieving net-zero emissions, supporting the relevance of comparing electrification with other measures. It does not provide the requested Yantian-specific figures.
6. The passage concerns pathways to decarbonize Hong Kong road transport, providing regional context on transport emissions and policy. It does not address Yantian drayage electrification or the rail and water mode-shift comparison.
7. This passage mentions low-carbon port initiatives and vehicle electrification targets in China, giving general policy context for port decarbonization. It does not quantify Yantian's well-to-wheel reductions or compare truck electrification with rail and water shifts.
8. This passage proposes broad transport-sector targets for 2035 across modes, which is relevant background for assessing transport decarbonization measures. It does not specify Yantian Port or the requested drayage and mode-shift emissions comparison.
9. This passage concerns public transport policies in national climate plans, rather than port freight or drayage trucks. It provides little direct information about the requested emissions estimate or rail and water comparisons.
10. This passage reports emissions-reduction effects of vehicle electrification in India's transport scenarios, which is only broadly related to the electrification component of the query. It does not cover Yantian Port or freight mode shifts.
11. This passage explicitly discusses pairing transport measures with freight-rail electrification and mode-share changes, making it relevant to the rail comparison. It does not provide the Yantian-specific drayage estimate or address the water-mode comparison in the excerpt.
12. This study examines zero-emission truck feasibility in Guangdong, which offers regional context for truck electrification. The excerpt does not state port-level well-to-wheel reductions or compare electrification with rail and water mode shifts.
13. This passage directly identifies shifting freight from trucks to rail as a freight-demand measure, relevant to comparing rail mode shift with drayage electrification. It does not provide Yantian Port figures or address water transport.
14. This passage concerns the assumptions used in a Guangdong zero-emission truck feasibility study, providing limited regional context for truck electrification. It does not contain the emissions estimate or mode-shift comparison requested.
15. This passage recommends zero-emission logistics vehicles in Guangdong cities, making it relevant background on regional freight electrification policy. It does not quantify Yantian Port's well-to-wheel reductions or compare them with rail and water measures.

**gpt-6.1-terra** (6256 ms)
1. This Shenzhen Port study identifies greater freight mode shift and cleaner electricity generation as ways to reduce remaining emissions. It provides context for the comparison but no numerical estimates.
2. This passage provides national context on when China's road transport emissions could peak, but it does not address Yantian Port or compare specific measures.
3. It identifies structural changes and vehicle electrification as priorities for China's transport decarbonization, without quantifying the Yantian Port scenarios.
4. The passage lists terminology for zero-emission heavy-duty trucks, which is relevant to truck electrification but gives no emissions results for Yantian Port.
5. This national road transport study says electrification alone is insufficient for net-zero emissions, providing context for combining electrification with other measures.
6. The passage discusses savings and investment in sustainable transport in Hong Kong, but does not address port drayage or freight mode-shift emissions.
7. It describes low-carbon port energy measures and vehicle electrification targets in Tianjin, offering related policy context rather than Yantian Port estimates.
8. It proposes global 2035 transport fuel and energy-consumption targets, providing broad decarbonization context but no port-specific comparison.
9. The passage inventories public transport measures in national climate plans, a related transport policy topic but not the freight measures in the query.
10. It references a table on emissions reductions from transport electrification in India, but the excerpt provides no Yantian Port figures.
11. It discusses freight rail investment and notes that rail electrification and grid modernization can increase emissions savings, relevant background for the rail comparison.
12. This Guangdong zero-emission truck study provides regional vehicle-analysis context, but the excerpt contains no usable well-to-wheel emissions comparison.
13. It describes shifting freight from trucks to rail as a transport demand management measure, relevant to the query's rail mode-shift comparison but not to Yantian's results.
14. This passage gives vehicle lifetime assumptions for a Guangdong zero-emission truck cost analysis, but does not report port emissions reductions.
15. It recommends incentives for zero-emission logistics vehicles in Guangdong cities, providing regional electrification policy context rather than the requested port-specific estimates.

## batch-relates

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2112 ms)
1. Projects regional zero-emission truck penetration above 50% in 2027–2030 and long-haul penetration around 15%–53% by 2035 under strengthened policies.
2. Provides technical assumptions for the 2035 truck analysis but does not state projected market penetration rates.
3. Discusses low-carbon vehicle deployment in China’s road transport but does not give the requested heavy-truck penetration projection.

**gpt-6.1-terra** (4733 ms)
1. Projects regional penetration above 50% in 2027–2030 and long-haul penetration of 15%–53% by 2035 under strengthened policies.
2. Lists vehicle mileage assumptions and terminology used in the 2035 heavy-duty truck analysis.
3. Discusses low-carbon vehicle technologies and freight efficiency without stating a heavy-duty truck penetration forecast.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (5876 ms)
1. Reports battery-electric trucks in Guangdong can reach TCO parity with diesel before model year 2025, especially 42-ton tractors.
2. Covers China road-transport decarbonization but provides no truck TCO comparison in the snippet.
3. Cites a study directly comparing battery-electric, fuel-cell, and diesel heavy trucks’ TCO in China.
4. Addresses zero-emission heavy-truck policy in China, but the snippet gives no TCO comparison.
5. References research comparing battery-electric and diesel heavy trucks’ TCO in China, without giving results.
6. Notes studies predicting Chinese battery-electric trucks’ TCO relative to diesel, but omits the comparison’s outcome.
7. Discusses China transport decarbonization but offers no heavy-truck TCO results in the snippet.
8. Examines battery-electric heavy trucks’ TCO against diesel equivalents for Shenzhen port operations, but gives no comparative results.
9. Cites a study comparing battery-electric, fuel-cell, and diesel heavy-truck TCO in China, without stating findings.
10. Compares Chinese electric and diesel heavy-truck TCO, reporting parity for some types under ideal one-for-one replacement.
11. Uses truck TCO in zero-emission-zone scenarios but does not compare battery-electric and diesel ownership costs.
12. Concerns Hong Kong road transport and TCO, not battery-electric versus diesel heavy trucks in China.
13. Compares bus technologies’ TCO in several regions, not heavy trucks in China.
14. Discusses electric-bus TCO outside China and does not address heavy-truck costs.
15. Analyzes electric-bus TCO and battery degradation, not Chinese heavy-truck comparisons.
16. Provides China transport emissions factors rather than heavy-truck ownership-cost comparisons.
17. Discusses electric-bus ownership costs in global cities, not Chinese heavy trucks.
18. Examines the TCO gap for U.S. electric and diesel school buses, not Chinese trucks.
19. Compares zero-emission and diesel trucks’ TCO in India rather than China.
20. Compares Indian electric and combustion auto-rickshaw costs, not heavy trucks in China.

**gpt-6.1-terra** (12858 ms)
1. Battery-electric trucks in Guangdong port, drayage, and urban delivery operations reach diesel TCO parity before model year 2025.
2. Its bibliography cites a study of electric vehicle costs and benefits in China.
3. It cites a dedicated comparison of Chinese heavy-truck ownership costs across battery-electric, fuel-cell, and diesel technologies.
4. It concerns policies for zero-emission heavy-duty freight in China, but the excerpt contains only unrelated references.
5. It addresses zero-emission heavy-duty trucks in China, but the excerpt does not provide cost comparisons.
6. It discusses electrification barriers in China's heavy-duty truck market, but its cost finding is truncated.
7. Its bibliography references research on electric vehicle costs and benefits in China.
8. It identifies ownership costs and operational feasibility as factors influencing battery-electric truck adoption at Yantian Port.
9. It cites a study comparing ownership costs of battery-electric, fuel-cell, and diesel heavy trucks in China.
10. Some battery-electric heavy trucks reach diesel TCO parity under an ideal one-for-one replacement assumption in Beijing.
11. It examines freight-zone scenarios and defines truck ownership costs, but the excerpt provides no electric-diesel comparison.
12. It discusses road transport decarbonization in Hong Kong and references ownership costs without comparing truck technologies.
13. Its tool compares ownership costs of electric and diesel buses, including fleets in China.
14. It reports that electric buses in India have lower lifetime costs than diesel buses.
15. It explains electric bus ownership cost analysis, including capital, operation, and battery replacement costs.
16. It presents Chinese vehicle particulate emission factors rather than ownership costs.
17. It reports electric bus fuel and maintenance savings in Izmir compared with conventional buses.
18. It identifies an ownership cost gap between electric and diesel school buses in the United States.
19. Its Indian fleet tool compares zero-emission and diesel trucks using ownership costs and other financial metrics.
20. It compares purchase and operating costs of electric and conventional auto-rickshaws in India.

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3098 ms)
1. It reports regional ZET market shares of 2–17% by 2030 without incentives, while long-haul adoption remains nascent through 2035.
2. It defines regional and long-haul scenario abbreviations but gives no adoption-potential comparison.
3. It discusses differing truck decarbonization timelines by duty cycle, but not a regional-versus-long-haul adoption comparison.
4. It assesses zero-emission vehicle decarbonization potential in Guangdong without comparing regional and long-haul truck adoption.
5. It evaluates freight-zone scenarios affecting regional and long-haul transport, not their relative zero-emission truck adoption potential.
6. It compares urban truck technologies and use cases, rather than regional and long-haul adoption scenarios.
7. It concerns zero-emission trucks in urban and regional delivery, but provides no regional-versus-long-haul adoption comparison.
8. It concerns urban and regional delivery feasibility, but the snippet offers no long-haul adoption comparison.
9. It describes a financial comparison tool for individual trucks, not adoption potential across transport scenarios.

**gpt-6.1-terra** (6494 ms)
1. Without incentives, regional delivery reaches 2–17% market share by 2030; long-haul adoption remains nascent through 2035.
2. Defines regional and long-haul scenario abbreviations and describes a residual-value sensitivity assumption.
3. Discusses barriers to heavy-duty electric truck adoption and differing decarbonization paces across duty cycles.
4. Identifies zero-emission vehicles as Guangdong's largest transport emissions-reduction opportunity.
5. Assesses zero-emission freight zone scenarios affecting regional and long-haul transport around Beijing.
6. Finds battery trucks suitable for urban delivery, while fuel-cell trucks compete better in longer-distance and heavy-duty applications.
7. Cites research on regional and long-haul truck electrification in a Guangdong delivery feasibility study.
8. Cites research on regional and long-haul truck electrification in a Guangdong delivery feasibility study.
9. Describes financial assumptions and geographic limitations of an Indian zero-emission truck feasibility tool.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (4145 ms)
1. Discusses zero-emission truck residual values and costs in China, but gives no battery-electric versus diesel payback periods.
2. Reports battery-electric truck total-cost parity with diesel by use case in Guangdong, not investment payback periods.
3. Examines residual-value assumptions for zero-emission trucks in China, without comparing payback periods.
4. Compares battery-electric and diesel truck ownership costs in Guangdong, but does not specify payback periods.
5. Defines payback period as a comparison metric but focuses on a tool and does not provide China-specific results.
6. Addresses China road-transport decarbonization broadly, without giving truck payback-period comparisons.
7. Cites a China study comparing battery-electric and diesel heavy-truck ownership costs, but gives no payback figures.
8. Provides electric-truck versus diesel cost gaps and distance thresholds in Beijing, rather than payback periods.
9. Discusses electric heavy-truck development in China but provides no comparative payback-period estimates.
10. Cites research on battery-electric and diesel heavy-truck ownership costs in China, without reporting payback periods.
11. References a China heavy-truck ownership-cost comparison but does not state payback periods.
12. Analyzes port transport decarbonization in Shenzhen but gives no truck payback-period comparison.
13. Discusses Hong Kong truck total-cost parity with diesel, not China-specific payback periods.

**gpt-6.1-terra** (8141 ms)
1. Assumed residual values affect the comparative lifetime costs of electric and diesel trucks.
2. Guangdong electric tractor-trailers reach total cost of ownership parity with diesel before model year 2025.
3. A sensitivity scenario assumes a 30% residual-value guarantee for zero-emission trucks.
4. Most electric trucks reach lifetime cost parity with combustion counterparts before model year 2027 without incentives.
5. Defines payback period and describes a tool comparing electric and diesel truck profitability in India.
6. Cites research on electric vehicle costs and benefits in China.
7. Cites a study comparing ownership costs of electric, fuel-cell, and diesel heavy trucks in China.
8. A 49-ton electric tractor-trailer costs 105,000 yuan more than its diesel counterpart over six years.
9. Discusses battery limitations and early electric heavy-truck models, including tractor units.
10. Cites a study comparing ownership costs of electric and diesel heavy trucks in China.
11. Cites a study comparing ownership costs of electric and diesel heavy trucks in China.
12. Examines alternatives to diesel trucking at Shenzhen's Yantian Port.
13. Discusses potential electric heavy-truck adoption after lifetime cost parity with diesel in Hong Kong.

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (7329 ms)
1. Discusses cycling’s potential to replace motorized trips but provides no replacement share in the snippet.
2. Covers China’s transport mode shares and decarbonization, not bike-share trip replacement rates.
3. Reports that 17–45% of Chinese dockless bike-share trips replaced private motorized trips.
4. Focuses on electric mobility in Vietnamese cities, not Chinese bike-share trip replacement.
5. Mentions Hangzhou’s bike-share system but gives no trip-replacement share.
6. Describes dockless bike-sharing’s growth in China without reporting what trips it replaces.
7. Notes expanding bike-sharing in China but provides no substitution share.
8. Reports Johannesburg travel modes, unrelated to Chinese bike-share substitution.
9. Discusses ride-hailing substitution in other regions, not bike-share in China.
10. Covers Hong Kong road transport emissions and vehicles, not bike-share trip substitution.
11. Addresses bicycle safety and public-transport access in China, without a replacement share.
12. Provides transport-emissions methodology, not bike-share substitution rates.
13. Examines ride-hailing in Uganda and India, not Chinese bike-share trips.
14. Discusses public bicycle sharing in India, not China or replacement shares.
15. Offers a general method for assessing micromobility impacts, without China-specific substitution figures.
16. Discusses on-demand ride-sharing trip replacement, not Chinese bike-share trips.
17. Reviews shared mobility generally, without China-specific bike-share replacement data.
18. Reports Surabaya travel modes, unrelated to Chinese bike-share substitution.
19. Discusses demand-responsive transit and mobility alternatives, not bike-share replacement shares in China.
20. Focuses on electric-vehicle grid impacts in China, not bike-share trips.
21. Covers informal transport in Latin America, not Chinese bike-sharing.
22. Notes bike-share expansion and car ownership in China but gives no replacement share.
23. Reports travel-mode shares in Guadalajara, not Chinese bike-share substitution.
24. Examines commuting and metro access in Bengaluru, not Chinese bike-share replacement.
25. Studies bus aggregators in India, not Chinese bike-share trips.
26. Discusses transport policies in Mexico, not Chinese bike-share substitution rates.

**gpt-6.1-terra** (12886 ms)
1. Discusses Chinese bike-sharing's potential to replace short motorized trips, without specifying the replacement share.
2. Shows changes in passenger transport mode shares in Beijing and China.
3. Reports that 17%–45% of shared-bike trips replace private motorized vehicle trips.
4. Reports walking, cycling, and electric taxi targets in Santiago.
5. Describes the scale of Hangzhou's bike-share system and potential health benefits.
6. Describes the emergence and rapid growth of dockless bike-sharing in China.
7. Notes that bike-sharing services operate in more than 360 Chinese cities.
8. Lists Johannesburg's trip shares by private car, walking, cycling, and taxi.
9. Discusses whether electric ride-hailing replaces private vehicle travel or adds trips.
10. Reports Hong Kong's registered private car and taxi counts.
11. Discusses cycling safety for last-mile connections to public transport in China.
12. Lists private cars and taxis among vehicle categories for transport emissions assessment.
13. Describes ride-hailing as a substitute for other travel modes in Kampala and Hyderabad.
14. Discusses the potential for public bicycle sharing in Indian cities.
15. Outlines how cities can assess shared micromobility's net greenhouse-gas impacts.
16. Discusses whether on-demand ride-sharing replaces public transport or walking trips.
17. Discusses the growth of shared mobility, including bike-sharing and car-sharing.
18. Lists Surabaya's trip shares by two-wheeler, private car, and public transport.
19. Identifies dockless bikes and ride-hailing as alternatives to private vehicles and other modes.
20. Projects the share of electric vehicles in China's taxi fleet.
21. Discusses motorcycle taxis and the difficulty of estimating informal transport's modal share in Latin America.
22. Notes bike-sharing's spread across Chinese cities alongside rising private car ownership.
23. Lists Guadalajara's trip shares by bicycle, private vehicles, buses, and taxis.
24. Discusses commuting mode choices and car use in Bengaluru.
25. Details assumptions for estimating car and taxi trip costs in India's National Capital Region.
26. Discusses reducing vehicle travel through public transport, cycling, and walking in Mexico.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3951 ms)
1. The study estimates dockless bike-sharing in China reduces CO₂ emissions by 4.8 million tonnes annually.
2. The report estimates Chinese bike-sharing reduces approximately 4.8 million tonnes of CO₂ annually.
3. Discusses Chinese road-transport decarbonization but gives no bike-sharing emissions reduction figure.
4. Describes bike-sharing systems and health impacts without quantifying China’s CO₂ reductions.
5. Describes Chinese bike-sharing systems but provides no CO₂ reduction estimate.
6. Models broad national emissions reductions, not bike-sharing’s contribution in China.
7. Addresses transport emissions accounting in China without estimating bike-sharing reductions.
8. Discusses bike-sharing integration and planning but gives no emissions-reduction figure.
9. Provides transport emissions methodology, not a bike-sharing reduction estimate.
10. Analyzes China’s road-transport emissions but does not quantify bike-sharing’s impact.
11. Covers environmental assessment of shared micromobility but gives no China-specific reduction figure.
12. Examines transport decarbonization in India rather than bike-sharing reductions in China.
13. Discusses public bike-sharing in India, not emissions reductions in China.
14. Addresses China’s urban emissions and climate policy without quantifying bike-sharing reductions.
15. Focuses on zero-emission trucks in Guangdong, not bike-sharing emissions reductions.

**gpt-6.1-terra** (8449 ms)
1. Estimates dockless bike-sharing reduces CO₂ emissions by 4.8 million tonnes annually.
2. Estimates shared bicycles reduce CO₂ emissions by approximately 4.8 million tonnes annually.
3. Discusses Chinese passenger transport mode shares and metro CO₂ emission factors.
4. Describes the scale of Hangzhou's bike-sharing system and potential health benefits.
5. Reports Hangzhou's bike-sharing fleet and station counts, but no emissions reduction.
6. Models an 89% emissions reduction by 2050 in China and India, without attributing it to bike-sharing.
7. Discusses rising transport CO₂ emissions and emissions accounting in Chinese cities.
8. Describes integration of bike-sharing and public transit payments in Hangzhou and Guangzhou.
9. Discusses transport's contribution to air pollution in Beijing and other Chinese cities.
10. Reports road transport's share of China's transport-related greenhouse gas emissions.
11. Discusses accounting methods for emissions associated with shared micromobility services.
12. Discusses shared mobility as a strategy for reducing transport energy consumption in India.
13. Explains a method for estimating bike-sharing CO₂ savings in India using assumed car emissions.
14. Discusses China's energy-related CO₂ emissions, air pollution, and urban traffic congestion.
15. Addresses zero-emission delivery trucks in Guangdong, not bike-sharing emissions savings.

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (4770 ms)
1. This report directly analyzes how dockless bike-sharing changes travel behavior and lives in Chinese cities.
2. This Chinese-language report directly examines dockless bike-sharing’s effects on urban travel behavior in Chinese cities.
3. It describes dockless bike-sharing’s rapid growth in China but does not explain its effects on travel behavior.
4. It discusses conventional bike-sharing in China, not dockless systems or their travel-behavior effects.
5. It describes China’s conventional bike-sharing system and general cycling benefits, not dockless-bike travel effects.
6. It covers passenger travel mode shares in China but does not specify dockless bike-sharing’s influence.
7. It cites a bike-sharing report but provides no findings about travel behavior.
8. It notes bike-sharing’s broad availability in Chinese cities without describing behavioral effects.
9. It concerns transport emissions and driving patterns, not dockless bike-sharing or travel behavior.
10. It addresses shared micromobility impacts generally, but the snippet does not identify effects in Chinese cities.
11. It concerns electric mobility in Vietnamese cities rather than dockless bike-sharing in China.
12. It discusses first- and last-mile mobility generally but does not address dockless bike-sharing in China.
13. It defines shared mobility broadly without discussing dockless bikes or Chinese travel behavior.
14. It describes a dockless bike-sharing launch in an Indian city, not travel effects in China.
15. It concerns cycling schemes in Mexican cities and does not address dockless bike-sharing in China.
16. It discusses cycling trends and infrastructure generally, not dockless bike-sharing’s effects in Chinese cities.
17. It discusses transportation choices and climate policy generally without examining dockless bike-sharing.

**gpt-6.1-terra** (11220 ms)
1. The report examines dockless bike-sharing in Chinese cities, but the excerpt does not describe travel behavior changes.
2. The report concerns dockless bike-sharing in Chinese cities; this excerpt contains only publication and author details.
3. Dockless bike-sharing began in China in 2015 and expanded rapidly from campus pilots.
4. Hangzhou's station-based bike-sharing system illustrates the scale of Chinese bicycle sharing, rather than dockless travel effects.
5. Hangzhou's station-based system and Barcelona's health findings provide context on bicycle sharing.
6. The report presents changes in passenger transport mode share, including Beijing's intracity trips.
7. The manual cites a Mobike white paper on bike-sharing and urban development.
8. The excerpt reports bike-sharing services in over 360 Chinese cities alongside rising car ownership.
9. The guide provides driving-condition assumptions for transport emissions calculations in a Chinese city.
10. The guide addresses environmental assessment of shared micromobility, including docked and dockless operations.
11. The excerpt lists electric-vehicle and emissions references for a Vietnamese urban mobility roadmap.
12. The report discusses first-mile and last-mile connections to transit hubs using shared rides.
13. The excerpt defines shared mobility and describes growth in ride-hailing services.
14. An Indian city's dockless bike-sharing rollout illustrates deployment and usage outside China.
15. The report discusses incorporating existing mode shares into sustainable mobility planning in Mexican cities.
16. The excerpt describes cycling's increased popularity during the pandemic and cities' infrastructure responses.
17. The excerpt discusses commuting decisions, transportation energy use, and urban land-use policies.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3020 ms)
1. Analyzes Yantian Port’s transport emissions and decarbonization pathways, directly informing whether its mode-shift targets are achievable.
2. Compares transport measures and mode-shift ambition across Guangdong regions, but does not assess Yantian Port’s targets.
3. Defines stated-policy and stronger structural-change scenarios useful for comparing mode-shift ambition, without evaluating Yantian Port.
4. Reports stated-policy green-transport assumptions for major cities, not Yantian Port’s freight-mode targets.
5. Describes policy tools to shift urban travel toward public transport, but does not assess Yantian Port or its targets.
6. Classifies local transport plans and emissions targets, but does not evaluate Yantian Port’s mode-shift feasibility.

**gpt-6.1-terra** (5568 ms)
1. Analyzes Yantian Port's domestic freight emissions, but the excerpt does not assess mode-shift targets or policy trajectories.
2. Compares Guangdong transport decarbonization measures and calls for proactive mode shifts outside the Pearl River Delta.
3. Defines national stated-policy and structural-change scenarios, the latter assuming greater transport mode shifts.
4. Describes stated-policy passenger transport targets for major Chinese cities, rather than port freight.
5. Discusses policies encouraging public transit and reducing private-car dependence in urban passenger travel.
6. Provides a framework for assessing local sustainable transport plans and emissions targets.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2074 ms)
1. Projects Yantian’s rail and waterway share above half by 2035 but does not identify expansion barriers.
2. Identifies uncompetitive rail pricing, underdeveloped intermodal services, and poor rail service quality as barriers in China.
3. Recommends infrastructure, connectivity, pricing, scheduling, and first-/last-mile improvements to address intermodal freight barriers.
4. Recommends promoting sea-to-rail services at Shenzhen Port but does not specify barriers.

**gpt-6.1-terra** (4153 ms)
1. Projects rail and waterways carrying over half of Yantian's throughput by 2035, without identifying barriers.
2. Identifies uncompetitive rail pricing, underdeveloped intermodal services, and limited rail service quality across China.
3. Recommends infrastructure, connectivity, pricing, scheduling, and first- and last-mile delivery improvements for Chinese intermodal freight.
4. Recommends promoting sea-to-rail and sea-to-water services at Shenzhen port without identifying barriers.

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (4947 ms)
1. The Shenzhen Port case study compares truck electrification with road-to-rail and other freight measures, likely containing the requested Yantian estimates.
2. Discusses national road-transport electrification and mode shifts, but not Yantian Port’s specific emissions comparison.
3. Provides China-wide freight mode-share and electrification targets, not port-specific well-to-wheel reductions.
4. Examines zero-emission heavy-truck policies in China, without Yantian Port or rail-and-water comparisons.
5. Describes national freight shifts and heavy-truck electrification as decarbonization strategies, not Yantian-specific impacts.
6. Focuses on Hong Kong road transport pathways, not Yantian Port’s truck electrification or mode-shift estimates.
7. Covers provincial transport targets and port measures, but gives no Yantian-specific well-to-wheel comparison.
8. Discusses broad transport decarbonization goals, not the requested port-level emissions estimates.
9. Focuses on public transport in national climate pledges, unrelated to Yantian freight emissions estimates.
10. Analyzes Indian transport scenarios, not Yantian Port or its freight mode-shift measures.
11. Supports freight rail and water shifts as emissions measures, but provides no Yantian-specific figures.
12. Studies zero-emission truck feasibility in Guangdong, potentially relevant to truck technology but not Yantian mode-shift comparisons.
13. Discusses shifting freight from trucks to rail in Mexico, not Yantian Port’s emissions effects.
14. Assesses zero-emission trucks in Guangdong, including port operations, but does not answer the Yantian comparison directly.
15. Recommends zero-emission drayage trucks in Guangdong, but does not quantify Yantian’s well-to-wheel reductions against rail and water shifts.

**gpt-6.1-terra** (9184 ms)
1. The Shenzhen port study compares decarbonization measures and identifies road-to-rail as the largest reduction opportunity.
2. A nationwide scenario estimates electrification's contribution to cumulative transport emissions reductions alongside freight mode shifts.
3. It outlines nationwide freight mode-share and vehicle electrification targets for carbon neutrality.
4. It examines zero-emission heavy-duty trucks in China, including battery-electric truck payload losses.
5. It discusses heavy-truck electrification, freight shifts to rail and water, and electricity decarbonization across China.
6. It compares passenger-car electrification scenarios in Hong Kong rather than port freight measures.
7. It lists Chinese provincial targets for vehicle electrification and rail-water freight transport.
8. It proposes global transport targets combining electrification, cleaner fuels, and shifts toward rail.
9. It counts countries' public transport and transit electrification commitments in climate plans.
10. It models transport electrification and emissions reductions in India, including freight vehicles and ships.
11. It discusses shifting freight from trucks to rail and water, alongside rail electrification.
12. It assesses zero-emission truck ownership costs in Guangdong, including electric trucks.
13. It discusses freight shifts from trucks to rail and electric vehicles in Mexico.
14. It assesses zero-emission truck economics in Guangdong, including port-operation use cases.
15. It recommends accelerating zero-emission drayage and other heavy-duty trucks in Shenzhen and Guangzhou.

## alignment

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2630 ms)
1. Two highly relevant results address China’s zero-emission heavy-duty trucks through 2035, and the results include Chinese-language publications.
2. The excerpt gives only a 2030 no-policy estimate: regional-delivery penetration is about 2%–17%; it does not provide the requested 2035 rate or long-haul estimates.
3. The third result is only weakly related, and the excerpts do not establish whether projections cover all new-energy trucks or only zero-emission trucks; request 2035 rates by scenario and transport setting.

**gpt-6.1-terra** (2796 ms)
1. The Chinese-language report directly addresses adoption through 2035, but the excerpt provides only a 2030 estimate: 2–17% for regional delivery without policy.
2. The 2035 penetration rate is not visible in the excerpts; consult the full report for projections by transport segment and policy scenario.
3. Avoid treating the 2030 range as a national forecast: it covers zero-emission trucks in regional delivery, not necessarily all new energy heavy-duty trucks.
4. Search for English terms such as “2035 China zero-emission heavy-duty truck penetration policy scenarios” and specify whether penetration means sales or fleet share.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2098 ms)
1. Strong matches include a China-focused heavy-truck ownership-cost study and a Guangdong delivery-use feasibility analysis; 10 of 20 results are rated highly relevant.
2. The excerpts mostly show titles or citations, not comparative cost estimates, assumptions, or findings, so they cannot establish which technology is cheaper or by how much.
3. Relevant publications include Chinese-language sources; refine the query by specifying truck class, duty cycle, ownership period, and assumptions such as electricity, diesel, battery, and charging costs.

**gpt-6.1-terra** (4250 ms)
1. The Guangdong case study directly addresses electric truck feasibility, but the excerpts do not establish a numerical ownership-cost comparison with diesel.
2. A Chinese-language publication cites a 2021 study comparing battery-electric, fuel-cell and diesel heavy trucks in China; retrieve that study to verify its findings.
3. Several excerpts are bibliography entries rather than evidence of results; relevance scores alone should not be treated as proof of cost parity.
4. Refine the search by truck class, province, delivery or long-haul use, and assessment year; request purchase, energy, maintenance and charging costs.

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2819 ms)
1. The strongest source directly compares regional and long-haul truck scenarios in China; its excerpt gives regional delivery 2–17% ZET market share by 2030 without incentives.
2. The long-haul estimate is cut off, so the excerpts do not establish the adoption gap; consult the full scenario results and compare assumptions and policy cases.
3. Other results address broader road-transport decarbonization or freight zones, which offer context but do not directly quantify this comparison; refine by specifying year and incentive scenario.
4. Relevant results include Chinese-language publications, alongside the English-titled lead source; the sample is promising but incomplete, with only two results rated highly relevant.

**gpt-6.1-terra** (2831 ms)
1. The strongest match estimates 2–17% regional-delivery adoption by model year 2030 without incentives, but the excerpt truncates the long-haul figure.
2. Relevant publications include Chinese-language sources. The other passages provide context on cost parity, policy and freight zones rather than a direct adoption comparison.
3. Retrieve the full regional-versus-long-haul study and compare scenario assumptions, policy incentives, vehicle types and adoption estimates for the same years.
4. Specify China and the desired timeframe, or broaden the geography to assess whether the findings apply elsewhere.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2387 ms)
1. China-focused sources cover zero-emission truck economics, including Guangdong use cases and diesel residual-value assumptions, but the excerpts do not provide battery-electric semi-truck payback periods directly.
2. The Guangdong study reports total-cost-of-ownership parity for several use cases, not necessarily investment payback; distinguish these metrics and verify whether its results cover semis specifically.
3. Relevant publications include Chinese-language sources. Refine the query by specifying long-haul semis, payback definition, comparison assumptions, and target year; current evidence is partial.

**gpt-6.1-terra** (2319 ms)
1. The China regional and long-haul study is relevant, but its excerpt gives no payback period; consult its full results before citing a figure.
2. The Guangdong study reports electric-truck cost advantages and projected parity before model year 2027, but cost parity is not a payback period.
3. Residual-value assumptions affect comparisons; the studies also cover different truck uses. Retrieved publications include Chinese-language sources.
4. Search for China battery-electric semi-truck payback periods versus diesel, specifying long-haul use, annual mileage, purchase year, and incentives.

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2906 ms)
1. The Chinese-language report directly addresses substitution, reporting that 17%–45% of trips replaced private motorized travel; the excerpt does not specify separate shares for cars, taxis, and ride-hailing.
2. The report also finds 54% of rides connect to other modes, 91% of those to public transit—useful context, but not a direct answer to the requested mode-specific share.
3. Evidence is promising but incomplete: query the report’s underlying survey tables and narrow the search to China bike-share mode substitution by private car, taxi, and ride-hailing; other results are less directly relevant.

**gpt-6.1-terra** (2871 ms)
1. A Chinese-language report excerpt cites a 17–45% substitution range, but truncates the affected mode; check the full report before attributing it to cars, taxis, or ride-hailing.
2. The excerpts do not establish a combined national share or separate estimates for each motorized mode. Search for mode substitution rates by Chinese city and survey year.
3. The two bike-share passages cite different survey sizes, 6,902 and 8,218; verify their populations and methods before combining or comparing results.
4. Other results address road transport, electric mobility, or bike-share system size rather than displaced trips; prioritize studies reporting respondents’ alternative travel modes.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2865 ms)
1. The Chinese-city study is directly relevant, but the excerpts report health benefits and transport substitution—not a quantified CO2 reduction—so they do not answer “how much.”
2. A Chinese-language WRI report says bike-sharing replaces some short motorized trips and brings emissions benefits; the provided passage gives no emissions total or calculation method.
3. Most results are not highly relevant, and the road-transport and design sources offer broader context rather than a direct bike-sharing estimate; avoid treating them as evidence of a specific reduction.
4. Refine the query to request a quantified annual CO2 estimate, its baseline and method, and specify dockless or station-based sharing and the Chinese cities or period; relevant sources include Chinese publications.

**gpt-6.1-terra** (2632 ms)
1. The dockless bike-sharing study surveys 8,218 users across 12 Chinese cities and estimates emissions benefits, but the excerpts provide no CO2 reduction figure.
2. Chinese-language results describe substitution of motorized trips and public-transit connections; system-size figures for Hangzhou do not establish emissions savings.
3. Avoid citing the mortality estimate as an emissions result. Check the full study for CO2 units, study year, baseline, and whether estimates include lifecycle emissions.
4. Refine the English query with “dockless bike sharing,” “China,” “annual CO2 emissions avoided,” and a city or study year.

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2593 ms)
1. The Chinese-city report directly matches the query, and a Chinese-language publication is also among the results; however, the excerpts provide little evidence about specific travel-behavior changes.
2. Only 2 of 17 results are highly relevant; broader bike-sharing technology and station-based Hangzhou examples may not capture dockless use or its effects on trip frequency, mode choice, and transit connections.
3. Refine the query around a behavior or outcome—such as car or transit substitution, trip distance, or usage frequency—and specify Chinese cities or a time period; current excerpts leave these perspectives uncertain.

**gpt-6.1-terra** (2281 ms)
1. The leading report directly addresses Chinese cities, but the excerpts do not establish effects on mode choice, trip frequency, or transit connections.
2. Results include Chinese-language publications; the two leading entries appear to be versions of the same report, limiting independent corroboration.
3. The Hangzhou example describes station-based sharing, not necessarily dockless systems; fleet counts alone do not demonstrate behavioral change.
4. Search for specific Chinese cities and outcomes such as mode substitution, first- and last-mile connections, and changes in car use.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2818 ms)
1. The top Chinese-language study directly analyzes Yantian Port’s domestic transport and distribution trips, but excludes international transloading and shipping—important boundaries for judging port-wide mode shift.
2. Chinese-language Guangdong and national road-transport studies describe policy scenarios and varying measure potential, but do not establish whether Yantian meets Shenzhen’s 2035 targets.
3. The results do not show a direct comparison with the Master Plan’s quantified targets or a Yantian-specific stated-policy forecast; treat any feasibility conclusion as uncertain.
4. Refine the query to compare Yantian’s baseline and projected freight-mode shares with Shenzhen’s 2035 targets, specifying stated-policy assumptions, port hinterland scope, and stronger-measure scenarios.

**gpt-6.1-terra** (2612 ms)
1. The Yantian study covers domestic port-related trips, but excludes international transshipment and shipping; its excerpt does not establish whether the 2035 targets are achievable.
2. The stated-policy scenario describes national road-transport policies, not necessarily a Yantian-specific trajectory; comparing it directly with port targets risks a misleading conclusion.
3. Retrieved publications include Chinese-language sources. Several discuss passenger transport or regional emissions rather than freight mode shift, leaving the port-specific evidence incomplete.
4. Search for Shenzhen's 2035 freight mode-share targets, Yantian baseline and projected shares, and policy scenarios comparing stated measures with stronger rail and waterway investments.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2674 ms)
1. A highly relevant Yantian-focused study targets railways and waterways exceeding 50% of port throughput by 2035, but the excerpt states an ambition, not the barriers to achieving it.
2. China-wide sources identify uncompetitive rail pricing, underdeveloped intermodal services, and limited rail service quality; these are plausible context, not confirmed Yantian-specific obstacles.
3. Relevant publications include Chinese-language sources. Search specifically for Yantian implementation constraints—pricing, rail capacity, terminal connections, and service reliability—to distinguish local evidence from national context.

**gpt-6.1-terra** (2669 ms)
1. The Yantian study sets a 2035 rail-and-water target but the excerpt does not identify barriers; consult the full Chinese publication for port-specific evidence.
2. A China-wide study cites uncompetitive rail pricing, underdeveloped intermodal services, and limited service quality; these barriers should not be assumed to apply to Yantian.
3. The Guangdong study recommends sea-to-rail services at Shenzhen but provides no implementation details in the excerpt; distinguish rail-water intermodal transport from road-to-rail shifting.
4. Refine the search with English terms such as “Yantian port rail access,” “intermodal terminal capacity,” “rail freight costs,” and “hinterland connections.”

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3075 ms)
1. The top result directly concerns low-carbon port transport and says greater freight mode shift and cleaner grid emissions are needed, but the excerpt gives no 95%-by-2035 emissions estimate.
2. The excerpts do not quantify Yantian-specific well-to-wheel reductions or compare truck electrification with rail and water shifts, so the requested magnitude remains unsupported here.
3. Broader China road-transport studies provide context, not a port-level comparison; relevant retrieved publications include Chinese-language sources.
4. Refine toward the Yantian port study’s scenario results, specifying baseline year, well-to-wheel CO2 metric, electrification share, and separate rail-versus-water mode-shift cases.

**gpt-6.1-terra** (2675 ms)
1. The leading Chinese-language port study discusses freight mode shift and grid decarbonization, but the excerpt does not quantify Yantian’s 95% electrification scenario.
2. The excerpts provide no well-to-wheel reduction figures or direct comparison with rail and water measures; broader national road-transport findings cannot substitute for port-specific estimates.
3. Search the port study for “Yantian 2035 drayage electrification 95% well-to-wheel emissions rail water mode shift,” and check scenario baselines and grid assumptions.

## translate

### q1_zero-emission-heavy-duty-trucks: What is the projected market penetration rate of new energy heavy-duty trucks in China through 2035?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (3130 ms)
> Driving Toward 2035: A Study of the Potential to Promote New Energy Heavy-Duty Trucks in China’s Regional and Long-Haul Transport Scenarios

This report assesses the potential and policy effects of promoting zero-emission heavy-duty trucks (ZETs) in China’s regional delivery (RD) and long-haul (LH) transport scenarios from 2024 to 2035. The findings show that, in the no-policy scenario, ZET penetration in RD reaches only about 2%–17% by model year 2030, while LH remains at an early stage through 2035. Existing policies can significantly increase regional adoption—primarily of battery-electric tractors—by 2027, but adoption may decline after subsidies expire. Among stronger policy measures, reducing highway tolls (for example, by 50%) is the most effective at increasing penetration, followed by accelerating the construction of dedicated fast-charging networks for heavy-duty trucks and lowering nighttime charging costs. Combining stronger policies could push ZET penetration in RD above 50% during MY2027–2030 and drive substantial growth in LH during MY2032–2035, reaching about 15%–53% by 2035. The study highlights the significant effects of uncertainty around operations, technology, and fuel and electricity prices. It recommends setting targets by scenario and vehicle type, carefully assessing the fiscal impact of toll reductions, prioritizing heavy-duty truck charging infrastructure, and establishing scenario-specific systems for operational data collection and support.

**gpt-6.1-terra** (8857 ms)
> Driving Toward 2035: A Study of the Deployment Potential of New Energy Heavy-Duty Trucks in China’s Regional and Long-Haul Transport

This report assesses the potential for deploying zero-emission heavy-duty trucks (ZETs) in regional delivery (RD) and long-haul (LH) transport in China from 2024 to 2035, as well as the effects of related policies. The findings show that, in a no-policy scenario, ZET penetration in the RD segment would reach only about 2%–17% by model year 2030, while adoption in the LH segment would remain at an early stage through 2035. Existing policies could substantially increase regional adoption, primarily of battery-electric tractor-trailers, by 2027, but adoption could decline after subsidies expire. Among strengthened policies, expressway toll reductions (such as 50%) are the most effective in increasing penetration, followed by accelerating the development of a dedicated fast-charging network for heavy-duty trucks and reducing nighttime charging costs. Combining strengthened policies could raise penetration in the RD segment above 50% during MY2027–2030 and drive significant growth in the LH segment during MY2032–2035, reaching approximately 15%–53% in 2035. The study finds that operational, technological, and fuel and electricity price uncertainties have substantial impacts. It recommends setting targets by use case and vehicle type, carefully assessing the fiscal impact of toll reductions, prioritizing improvements to charging infrastructure for heavy-duty trucks, and establishing use-case-specific operational data collection and support mechanisms.

### q2_bev-diesel-truck-tco-china: How does total cost of ownership compare between battery electric and diesel heavy-duty trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (1880 ms)
> Techno-Economic Feasibility Analysis of Zero-Emission Trucks in Urban and Regional Delivery Use Cases: A Case Study of Guangdong Province, China Battery electric trucks (BETs) in port operations, drayage, and urban delivery reach total cost of ownership (TCO) parity with diesel before MY2025 in Guangdong, China—particularly 42-ton tractor trailers. Fuel-cell trucks achieve parity later, around MY2028–2030. Comprehensive policy packages—tax exemptions, energy incentives, road access privileges, ...

**gpt-6.1-terra** (4657 ms)
> Techno-Economic Feasibility Analysis of Zero-Emission Trucks in Urban and Regional Delivery Use Cases: A Case Study of Guangdong Province, China Battery electric trucks (BETs) in port operations, drayage, and urban delivery reach total cost of ownership (TCO) parity with diesel before MY2025 in Guangdong, China—particularly 42-ton tractor trailers. Fuel-cell trucks achieve parity later, around MY2028–2030. Comprehensive policy packages—tax exemptions, energy incentives, road access privileges, ...

### q3_regional-vs-longhaul-adoption: What is the difference in zero-emission truck adoption potential between regional transport and long-haul transport scenarios?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2699 ms)
> The key findings are as follows: First, without policy incentives, ZETs would have a modest market share of 2–17 percent in regional delivery by MY2030, while ZET adoption in long-haul trucking would remain at a nascent stage through MY2035. Battery electric trucks will dominate regional delivery, but the optimal technology mix for long-haul applications is uncertain. [{"box_2d": [78, 365, 480, 500, "label": "text", "caption": "In both applications, zero-emission tractor trailers are more likely to achieve a wide adoption than zero-emission straight trucks. This is primarily due to a wider cost gap between zero-emission straight trucks and their diesel counterparts, driven by greater payload losses in zero-emission straight trucks. Additionally, diesel straight trucks are generally more energy-efficient and have lower purchase costs than diesel tractor trailers."}] In terms of technology selection, battery electric trucks are more cost-competitive than fuel cell electric trucks for regional delivery and are expected to dominate this market segment. For long-haul trucking (particularly for tractor trailers), the optimal technology mix is uncertain.

**gpt-6.1-terra** (7768 ms)
> The key findings are as follows: First, without policy incentives, regional delivery would see a modest ZET market share of 2–17 percent by MY2030, while ZET adoption would remain at a nascent stage for long-haul trucking through MY2035. Battery electric trucks will dominate regional delivery, but for long-haul application, the optimal technological mix is uncertain.[{"box_2d": [78, 365, 480, 500, "label": "text", "caption": "In both applications, zero-emission tractor trailers are more likely to achieve a wide adoption than zero-emission straight trucks. This is primarily due to a wider cost gap between zero-emission straight trucks and their diesel counterparts, driven by greater payload losses in zero-emission straight trucks. Additionally, diesel straight trucks are generally more energy-efficient and have lower purchase costs than diesel tractor trailers."}] In terms of technology selection, for regional delivery, battery electric trucks are more cost-competitive than fuel cell electric trucks and are expected to dominate this market segment. For long-haul trucking (particularly for tractor trailers), the optimal technological mix is uncertain.

### q4_bev-payback-periods: What are the payback periods for battery electric semi-trucks compared to diesel trucks in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2774 ms)
> It is assumed that diesel trucks retain about 30 percent of their retail price as residual value after their first use (Pers. Comm. 2024; Basma et al. 2021). This assumption likely underestimates ZET residual values (and their cost competitiveness). Under this assumption, ZET residual values account for 7–25 percent of their retail price, with particularly low residual values for longer-range BETs in the LH application, where greater battery capacity would typically result in higher resale value. To address this issue, we also developed several scenarios with increased ZET residual values to evaluate their impact on ZET adoption (see the subsection below, “Scenario analysis and uncertainty analysis”).

28 | WRI.ORG.CN

# METHODS OF PROJECTING ZET PAYBACK PERIODS AND MARKET SHARE

The cumulative effect of the above decision variables is reflected in the projected ZET payback periods and TCO by application:

- ■ “Payback period” refers to the number of years required to recoup the higher capital cost of a ZET compared to a diesel truck through the ZET’s operational cost savings. In the RD application, diesel trucks generally have a useful life of seven to 10 years (Pers. Comm. 2024; CATARC 2022). Thus, ZET adoption is deemed feasible when the payback period is within five years (Shenzhen Xieli 2022).

**gpt-6.1-terra** (8983 ms)
> Diesel trucks are assumed to retain about 30 percent of their retail price as residual value after first use (Pers. Comm. 2024; Basma et al. 2021). The above assumption likely underestimates ZET residual values (and their cost-competitiveness). Under the above assumption, ZET residual values account for 7–25 percent of their retail price, with particularly low residual values for longer-range BETs in the LH application, where larger battery capacity would typically result in higher resale value. To remedy this problem, we also developed several scenarios with increased ZET residual values to evaluate their impact on ZET adoption (see the subsection below “Scenario analysis and uncertainty analysis”). 28 | WRI.ORG.CN # METHODS OF PROJECTING ZET PAYBACK PERIODS AND MARKET SHARE The cumulative effect of the above decision variables is reflected in the projected ZETs' payback periods and TCO by application: - ■ “Payback period” refers to the number of years required to recover the higher capital cost of a ZET compared to a diesel truck through ZETs' operational cost savings. For the RD application, diesel trucks generally have a useful life of seven to 10 years (Pers. Comm. 2024; CATARC 2022). Thus, ZET adoption is deemed feasible when the payback period is within five years (Shenzhen Xieli 2022).

### q5_bikeshare-trip-substitution: What share of bike-share trips replace private car, taxi, or ride-hailing trips in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2714 ms)
> Notes: n = 6,902 Source: Survey results. 22 WRI.org.cn For short- and medium-distance trips, people prefer cycling to walking and buses (which rely on fixed schedules) because it saves time. In most cities, motorized vehicles are overused for short-distance travel. For example, 39.3 percent of car trips in Beijing are less than 5 kilometers (BTI 2016). This means that cycling has enormous potential to replace motorized trips in cities. Based on the survey results (shown in Table 3-1), depending on the city, 17–45 percent of the total kilometers traveled using dockless bike-sharing replaced kilometers traveled by motorized modes (including private cars, taxis, ride-hailing, and motorcycles). Moreover, bike-and-ride (combining bicycle and public transport for a single trip) may also have the potential to replace long-distance trips by private motorized vehicles. These impacts—especially the replacement of private vehicle travel—may be underestimated, since the questionnaire was designed to understand trips completed using DBS, rather than the entire travel chain. Furthermore, the results indicate that travelers prefer to use dockless bikes because they believe cycling offers opportunities for health benefits and is an environmentally friendly mode of travel.

**gpt-6.1-terra** (6900 ms)
> Notes: n = 6,902 Source: Survey results. 22 WRI.org.cn For short and medium trips, compared with walking and buses (relying on fixed bus schedules), people prefer cycling, as it is time-saving. In most cities, motorized vehicles are overused for short-distance travel. For example, 39.3 percent of car trips are less than 5 kilometers in Beijing (BTI 2016). This means cycling has enormous potential for replacing motorized trips in cities. Based on the survey results (shown in Table 3-1), depending on the city, 17–45 percent of total dockless bike-sharing kilometers traveled replaced motorized kilometers traveled (including private cars, taxis, ride-hailing, and motorcycles). Moreover, bike-and-ride (combined use of bicycle and public transport for one trip) may also have the potential to replace long-distance private motorized trips. And these impacts, especially in terms of replacing private vehicle travel, may be underestimated, as the questionnaire is designed to understand the trips finished by DBS, rather than the entire travel chain in this report. Furthermore, according to the results, travelers prefer to use dockless bikes since they believe cycling provides opportunities for health gains, as an environmentally friendly travel mode.

### q6_bikeshare-co2-reduction: How much CO2 emissions reduction is attributed to bike-sharing in China?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (1844 ms)
> How Dockless Bike Sharing Changes Lives: An Analysis of Chinese Cities

Surveying 8,218 DBS users across 12 Chinese cities, DBS cycling yields net annual mortality avoided of 59,635 among 235 million users. Cycling up to one hour daily is optimal at PM2.5 levels of 50–60µg/m³; cycling beyond 30 minutes is inadvisable above 160µg/m³. DBS reduces CO₂ by 4.8 million tonnes annually. Some 54% of users connect DBS to other modes, with 91% linking to public transit. An estimated 15,556 annual bike fat...

**gpt-6.1-terra** (6518 ms)
> How Dockless Bike Sharing Changes Lives: An Analysis of Chinese Cities Surveying 8,218 DBS users across 12 Chinese cities, DBS cycling yields net annual mortality avoided of 59,635 among 235 million users. Cycling up to one hour daily is optimal at PM2.5 levels of 50–60µg/m³; cycling beyond 30 minutes is inadvisable above 160µg/m³. DBS reduces CO₂ by 4.8 million tonnes annually. Some 54% of users connect DBS to other modes, with 91% linking to public transit. An estimated 15,556 annual bike fat...

### q7_bikeshare-travel-behavior: How does dockless bike-sharing affect travel behavior in Chinese cities?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (1909 ms)
> # HOW DOCKLESS BIKE-SHARING CHANGES LIVES: AN ANALYSIS OF CHINESE CITIES

Jiang Hui  
Song Su  
Zou Xuan  
Lu Lu

WRI.ORG.CN

Report QR code:

## Authors

Jiang Hui, Associate Researcher, World Resources Institute (WRI) China

Song Su, Researcher, World Resources Institute (WRI) China

Zou Xuan, Intern, World Resources Institute (WRI) China

Lu Lu, Associate Researcher, World Resources Institute (WRI) China

This report was supported by the Oak Foundation, Stephen M. Ross Philanthropies, and the William and Flora Hewlett Foundation.

![img-4.jpeg](img-4.

**gpt-6.1-terra** (5810 ms)
> # How Dockless Bike-Sharing Affects Cities ## HOW DOCKLESS BIKE-SHARING CHANGES LIVES: AN ANALYSIS OF CHINESE CITIES Jiang Hui Song Su Zou Xuan Lu Lu WRI.ORG.CN Report QR code: ## Authors Jiang Hui, Associate Researcher, World Resources Institute (United States) Beijing Representative Office Song Su, Researcher, World Resources Institute (United States) Beijing Representative Office Zou Xuan, Intern, World Resources Institute (United States) Beijing Representative Office Lu Lu, Associate Researcher, World Resources Institute (United States) Beijing Representative Office This report was supported by the Oak Foundation, Stephen M. Ross Philanthropies, and the William and Flora Hewlett Foundation. ![img-4.jpeg](img-4.

### q8_yantian-port-mode-shift-targets: Can Yantian Port realistically meet the mode-shift targets set in Shenzhen's Master Plan (2035), or would it require more aggressive measures than a "stated policy" trajectory?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2262 ms)
> The emissions scope of the analysis covered all domestic transportation and distribution trips that originated or ended at Yantian Port, excluding international transloading and shipping, as well as emissions from port handling equipment. The emissions accounting method used was a bottom-up, activity-based approach, with data collected through stakeholder interviews and a literature review. Due to insufficient data availability, we did not evaluate the cost-effectiveness of different optimization measures.

## Research findings and recommendations

The scenario construction revealed that shifting containers to railways and waterways would be so challenging for Yantian Port that reaching the mode shift targets set in the *Master Plan of Shenzhen Port (2035)* would be difficult without aggressive measures. Therefore, we constructed the following scenarios in this study (Table ES-1): (1). Enhanced-policy scenario (“Enhanced_policy”): This scenario assumed that Yantian Port would meet the freight mode shift targets outlined in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018). By 2035, Yantian Port would rely on railways and waterways for container transportation and distribution, with the two modes together accounting for over 50 percent of the port throughput.

**gpt-6.1-terra** (5831 ms)
> The emissions scope of the analysis covered all the domestic transportation and distribution trips that originated or ended at Yantian Port, excluding international transloading and shipping and the emissions from port handling equipment. The emissions accounting method we used is a bottom-up activity-based method with data acquired through stakeholder interviews and a literature review. It should be noted that due to insufficient data availability, we did not evaluate the cost-effectiveness of different optimization measures. ## Research findings and recommendations The scenario construction revealed that shifting containers to railways and waterways would be so challenging for Yantian Port that it would be difficult for the port to reach the mode shift targets set in the *Master Plan of Shenzhen Port (2035)* without taking aggressive measures. Therefore, we constructed scenarios as follows in this study (Table ES-1): (1). Enhanced-policy scenario (“Enhanced_policy”): This scenario assumed that Yantian Port will reach the freight mode shift targets outlined in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018). By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution—together, the two modes will account for over 50 percent of the port throughput.

### q9_yantian-port-rail-water-barriers: What are the barriers to expanding rail-water intermodal transport (road-to-rail) at Yantian Port?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2467 ms)
> By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution, with the two modes together accounting for over 50 percent of port throughput. We further assumed that battery-electric HDTs will account for 15 percent of the fleet by 2035. Because this assumption is conservative, we also analyzed the environmental benefits of a 95 percent fleet penetration rate for battery-electric drayage trucks in 2035 under the same scenario. (2). Stated-policy scenario (“Stated_policy”): Because railway construction and the expansion of the port’s catchment areas would take years, shifting containers to railways and waterways by 2025 would be challenging. Therefore, this scenario assumed that it would not be feasible to meet the freight mode shift targets outlined in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018) by 2025. Furthermore, given the uncertainty surrounding the future expansion of the port’s hinterland areas to make railways and waterways more cost-competitive (Yantian Port currently serves mostly Guangdong Province), we assumed that the port would not meet the freight mode shift targets set in the *Master Plan of Shenzhen Port (2035)* by 2035. In the future, Yantian Port will continue to depend heavily on roadways for container transportation and distribution. (3).

**gpt-6.1-terra** (7452 ms)
> By 2035, Yantian Port will rely on railways and waterways for container transportation and distribution—together, the two modes will account for over 50 percent of the port throughput. Further, we assumed that battery-electric HDTs will represent 15 percent of fleet penetration by 2035. Since this assumption is conservative, we also analyzed the environmental benefits of having a 95 percent fleet penetration of battery-electric drayage trucks in 2035 in the same scenario. (2). Stated-policy scenario (“Stated_policy”): Because railway construction and expansion of the port’s catchment areas would take years, it would be challenging to shift containers to railways and waterways by 2025. Therefore, this scenario assumed that it is infeasible to reach the freight mode shift targets outlined in the *Master Plan of Shenzhen Port (2035)* (TPRI 2018) by 2025. Further, given that expansion of the port’s hinterland areas to make railways and waterways more cost-competitive (currently, Yantian Port mostly serves Guangdong Province) has future uncertainties, we assumed that the port will not reach the freight mode shift targets set in the *Master Plan of Shenzhen Port (2035)* by 2035. In the future, Yantian Port will still heavily depend on roadways for container transportation and distribution. (3).

### q10_yantian-port-drayage-electrification-co2: How much would well-to-wheel CO2 emissions decline if drayage truck electrification reached 95% by 2035 at Yantian Port, and how does that compare to rail and water mode-shift measures?

**check:** ✓ gpt-6-luna · ✓ gpt-6.1-terra

**gpt-6-luna** (2298 ms)
> Reducing the remaining carbon emissions would require more aggressive measures such as greater degrees of freight mode shift and upstream decarbonization of grid emissions (see Figure ES-1). Second, although the optimization measures examined in this study have decarbonization potentials, not all measures have air pollution reduction co-benefits. Road-to-rail delivers the largest decarbonization and air pollutant reduction potential among the measures examined in this study. The promotion of battery-electric HDTs could also provide air pollution reduction co-benefits: Zero-emission HDTs representing 95 percent of the drayage truck fleet in 2035 would have the second-largest emission reduction potential, following road-to-rail (see Figure ES-2).

Figure ES-1 | Well-to-wheel carbon dioxide emissions in the three policy scenarios

Note: CO₂ = carbon dioxide. Source: Authors' calculations.

Figure ES-2 | Reduction of well-to-wheel carbon dioxide emissions in Enhanced_policy scenario with 95% battery electric drayage trucks in the fleet by different measures

Note: WTW = well-to-wheel; CO₂ = carbon dioxide; HDT = heavy-duty truck; BAU = business as usual. Source: Authors' calculations.

**gpt-6.1-terra** (7030 ms)
> Reducing the remaining carbon emissions would require more aggressive measures such as greater degrees of freight mode shift and upstream decarbonization of grid emissions (see Figure ES-1). Second, although the optimization measures examined in this study have decarbonization potentials, not all measures have air pollution reduction co-benefits. Road-to-rail delivers the largest decarbonization and air pollutant reduction potential among the measures examined in this study. The promotion of battery-electric HDTs could also provide air pollution reduction co-benefits: Zero-emission HDTs representing 95 percent of the drayage truck fleet in 2035 would have the second-largest emission reduction potential, following road-to-rail (see Figure ES-2). Figure ES-1 | Well-to-wheel carbon dioxide emissions in the three policy scenarios Note: CO₂ = carbon dioxide. Source: Authors' calculations. Figure ES-2 | Reduction of well-to-wheel carbon dioxide emissions in Enhanced_policy scenario with 95% battery electric drayage trucks in the fleet by different measures Note: WTW = well-to-wheel; CO₂ = carbon dioxide; HDT = heavy-duty truck; BAU = business as usual. Source: Authors' calculations.
