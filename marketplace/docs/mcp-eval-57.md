# ASK: SEOUL MCP — 제품 대표질문 57건 실측 (2026-08-07~08)

각 제품의 `product_question` 을 그대로 headless Claude 에 던지고, 원격 https://ask-seoul.kr/mcp 만 붙여 답을 받았다.

| # | 제품 | 질문 | MCP 툴 경로 | 판정 | 답 요지 |
|---|---|---|---|---|---|
| 0 | commerce_address_succession | 폐업 자리에 무슨 업종이 들어서나(자리 대물림)? | list_products → describe_product → query_product | 정상 | 서울 인허가 데이터의 `commerce_address_succession`(폐업 후 같은 도로명주소에 365일 이내 들어온 후속 개업 매칭, 총 약 25.3만 건)을 전량 조회해 분석한 결과입니다. ## 결론: 폐업 |
| 1 | commerce_age_band | 신상 가게와 노포의 비중은? | list_products → describe_product → run_pattern | 정상 | 서울시 인허가 업소 데이터(`commerce_age_band`, 영업 중인 업소 약 96만 곳 기준)로 확인했습니다. ## 서울 전체 영업 업소의 업력 분포 / 업력 구간 / 업소 수 / 비중 / /---/---:/ |
| 2 | commerce_area_profile | 업종별 매장 면적 분포는? | list_products → describe_product → run_pattern | 정상 | ## 업종별 매장 면적 분포 (서울시 인허가 데이터, `commerce_area_profile`) 서울시 인허가 데이터의 영업장 면적(sitearea) 기준으로, 업종 간 매장 크기 격차가 **최대 약 1,000배* |
| 3 | commerce_change_activity | 업소 정보 변경이 활발한 업종은? | list_products → describe_product → query_product | 정상 | 서울시 인허가 데이터(`commerce_change_activity`, 152개 업종)를 전수 조회해 분석했습니다. "변경이 활발하다"는 걸 어떤 축으로 보느냐에 따라 1위가 달라지는데, 결과를 축별로 정리하면 다음 |
| 4 | commerce_churn_yearly | 연별 교체율·신생비는? | list_products → describe_product → run_pattern | 정상 | 서울 전체 연도별 교체율(폐업/연초 스톡)·신생비(개업/연초 스톡) 데이터입니다 (`commerce_churn_yearly`, 최근 20개 완결연 2006~2025). / 연도 / 개업 / 폐업 / 순증 / 교체율  |
| 5 | commerce_cohort_survival | 창업 후 몇 년을 버티나(코호트 생존율)? | list_products → describe_product → run_pattern | 정상 | **한 줄 답: 서울 창업 업소는 첫 1년에 15~20%가 문을 닫고, 5년이면 절반 가까이, 10년이면 업종에 따라 25~52%만 살아남습니다.** (서울 인허가 데이터 기반 `commerce_cohort_surv |
| 6 | commerce_data_quality | 이 데이터셋의 품질(연락처·좌표·주소 커버리지)은? | list_products → describe_product → query_product | 정상 | 조회를 마쳤습니다. `commerce_data_quality` 제품(서울 인허가 데이터 152개 API의 필드 커버리지 진단, 2026-07-31 기준 산출)이 이 질문에 해당하는 데이터라서, 152행 전체를 조회해 |
| 7 | commerce_dong_category_matrix | 이 동네엔 무슨 업종이 많나? | list_products → describe_product | 정상 | 확인 결과, 이 질문에 딱 맞는 데이터가 있습니다 — `commerce_dong_category_matrix` (서울 행정동 × 업종 중분류별 영업 업소 수 + 최근 1년 개업 수, 2026-07-31 기준 추출). |
| 8 | commerce_dong_summary | 우리 동네(행정동)에 업소가 몇 개 있고 얼마나 열고 닫혔나? | list_products → describe_product | 정상 | 딱 맞는 데이터를 찾았습니다 — `commerce_dong_summary`(행정동별 업소 현황 스냅샷, 서울 417개 동)가 바로 이 질문("우리 동네에 업소가 몇 개 있고 얼마나 열고 닫혔나")을 위한 제품입니다. |
| 9 | commerce_env_facility_operation | 환경시설의 가동 일수·시간은? | list_products → describe_product → query_product | 정상 | 서울 열린데이터의 **환경 배출시설 인허가 데이터(대기·수질, 자치구별)** 로 확인한 결과입니다. 결론부터 말하면, **분석 가능한 축은 대기오염 배출시설뿐이며, 서울 전체 대기 배출시설은 연평균 약 205일, 하 |
| 10 | commerce_flow_monthly | 개·폐업 흐름 추이(월) | list_products → describe_product → run_pattern | 정상 | ## 서울 전체 개·폐업 흐름 추이 (월별) `commerce_flow_monthly` 데이터(최신 완결월: 2026-07)에서 최근 25개월 추이를 조회했습니다. / 연월 / 개업 / 폐업 / 순증 / /---/- |
| 11 | commerce_flow_yearly | 개·폐업 흐름 추이(연) | list_products → describe_product → run_pattern | 정상 | 확인 완료 — 질문하신 "개·폐업 흐름 추이(연)"에 딱 맞는 데이터 상품(`commerce_flow_yearly`, 서울 인허가 기반 연 단위 개·폐업 집계, 기준 2025년까지 완결연)을 조회했습니다. ## 핵심 |
| 12 | commerce_geo_grid_detail | 상권이 어디에 밀집해 있나(500m 격자)? | list_products → describe_product → run_pattern | 정상 | 상권 밀집 상위 격자를 조회했습니다. 결론부터 말하면 **서울 상권은 ① 가산·구로 디지털단지, ② 강남(강남역~테헤란로~선릉·삼성), ③ 홍대, ④ 을지로·명동** 네 축에 뚜렷하게 밀집해 있고, 그중에서도 강남  |
| 13 | commerce_geo_grid_overview | 상권이 어디에 밀집해 있나(500m 격자)? | list_products → describe_product → query_product | 정상 | 집계가 끝났습니다. 결과를 정리해 드립니다. ## 서울 상권 밀집 500m 격자 분석 결과 `commerce_geo_grid_overview`(0.005도 ≈ 500m 격자 × 업종 대분류, 총 7,642행)를 전량 |
| 14 | commerce_gu_specialization | 이 자치구는 어떤 업종이 특화됐나(LQ)? | list_products → describe_product → query_product | 정상 | 서울 25개 자치구 전체의 업종 특화지수(LQ) 데이터를 조회했습니다 (`commerce_gu_specialization`, 자치구×업종 283행, LQ>1이면 서울 평균 대비 밀집). 질문에 특정 구가 지정돼 있지 |
| 15 | commerce_lifespan | 업종별 폐업까지 걸리는 수명은? | list_products → describe_product → run_pattern | 정상 | 서울시 인허가 데이터(`commerce_lifespan`, 폐업 완결 업소 기준)로 확인한 결과입니다. ## 업종별 폐업까지 걸리는 수명 (서울시) **가장 오래 버티는 업종 Top 5** (가중평균 수명, 폐업 건 |
| 16 | commerce_multi_site | 다점포 운영이 흔한 업종은? | list_products → describe_product → run_pattern | 정상 | 서울시 인허가 데이터(동일 전화번호 다지점 기준, 지점 100곳 이상 업종)로 보면, **다점포 운영이 가장 흔한 업종은 영화상영관(96.2%)이고, 배급·유통형 업종이 상위권을 휩씁니다.** 서울 전체 평균은 전화 |
| 17 | commerce_phone_succession | 전화번호가 승계되는 업종 조합은? | list_products → describe_product → run_pattern → query_product | 정상 | ## 전화번호가 승계되는 업종 조합 — `commerce_phone_succession` 조회 결과 이 데이터는 폐업한 업소의 전화번호가 3년 이내에 **다른 주소**에서 다시 개업 신고에 나타나는 경우(= 폐업 사 |
| 18 | commerce_seasonality | 개·폐업이 몰리는 달은 언제인가? | list_products → describe_product → run_pattern | 정상 | **개업은 1월, 폐업은 12월에 몰립니다.** (서울 인허가 데이터, 최근 10개 완결연도 누적 기준) / 구분 / 피크 달 / 건수 / 비고 / /---/---/---/---/ / 개업 / **1월** (111, |
| 19 | commerce_status_duration | 인허가 상태에 얼마나 머무나? | list_products → describe_product → run_pattern | 정상 | ## 답: 상태군에 따라 **평균 150~175일** 머뭅니다 — 다만 이건 "최소 이만큼"이라는 하한값입니다 `commerce_status_duration`(서울 인허가 상태 지속기간, 636행) 상품이 바로 이  |
| 20 | commerce_status_transition | 영업→폐업 등 상태 전이는 어떤 경로인가? | list_products → describe_product → run_pattern | 정상 | **결론: 서울 인허가 업소의 상태 전이는 압도적으로 "영업→폐업 직행"이 지배합니다 — 전체 전이의 79.6%가 이 경로이고, 폐업으로 들어오는 건의 99.5%가 휴업을 거치지 않고 영업에서 곧바로 발생합니다.** |
| 21 | commerce_uptae_rollup | 업태 구성은 어떤가? | list_products → describe_product → run_pattern | 정상 | ## 서울 업태 구성 (commerce_uptae_rollup, 7,665행 기준) **전체 순위는 온라인(통신판매업)이 압도합니다.** 활성 업소 수 기준 상위 세부 업태는: / 순위 / 업태 / 소속 업종 / 활 |
| 22 | citydata_air_daily | 이 동네 미세먼지가 요즘 며칠간 어떤 추이입니까? | list_products → describe_product → query_product → run_pattern → preview_product | 정상 | # 최근 2주 미세먼지 추이 (서울, ~8/6 기준) **결론: 7월 말까지 꽤 깨끗하다가 8/1에 한 차례 확 나빠졌고, 그 뒤로는 매일 조금씩 좋아져서 지금은 '보통' 수준입니다.** 서울시 일별 대기질 데이터( |
| 23 | citydata_charger_dow_hour | 이 장소는 무슨 요일 몇 시에 EV 충전소가 잘 빕니까? | list_products → describe_product → query_product | 되물음 | 어떤 장소를 말씀하시는지 지정되지 않아 먼저 데이터 범위를 확인했습니다. 서울시 요일×시간 EV 충전기 가용 패턴 데이터(`citydata_charger_dow_hour`)가 있고, 서울 주요 명소 **105곳**에 |
| 24 | citydata_cmrcl_daily | 이 장소는 하루 결제·상권 활력이 어느 정도입니까? | list_products → describe_product → preview_product → run_pattern | 되물음 | 어떤 장소를 말씀하시는지 지정되지 않아서, 우선 서울시 장소별 일 소비 데이터(`citydata_cmrcl_daily`, 기준일 2026-08-07)로 전체 그림을 확인했습니다. 장소명을 알려주시면 해당 장소의 하루 |
| 25 | citydata_dst_daily | 서울에 어떤 재난 경보(폭염·호우 등)가 언제 얼마나 발령됐습니까? | list_products → describe_product → query_product | 정상 | 조회 결과입니다. 서울시 재난 경보(안전안내문자) 일별 집계 데이터(`citydata_dst_daily`, 기준 2026-08-07, 수집 기간 **2026-07-17 ~ 08-07**) 기준으로 총 **126건** |
| 26 | citydata_dst_dow_hour | 재난 경보는 주로 무슨 요일 몇 시에 발령됩니까? | list_products → describe_product → run_pattern → query_product | 정상 | **재난 경보는 주로 평일(수·목·금) 낮 11시와 14시 전후에 발령됩니다.** ASK Seoul의 `citydata_dst_dow_hour`(재난 경보 요일·시간 패턴, 총 126건 집계) 데이터 기준입니다. * |
| 27 | citydata_ppltn_daily | 이 장소는 하루 평균·최대 얼마나 붐볐습니까? | list_products → describe_product → preview_product | 되물음 | 어떤 장소를 말씀하시는지 확인이 필요합니다 — 이번 대화에 특정 장소가 아직 지정되지 않았습니다. 다만 이 질문에 딱 맞는 데이터는 이미 확인해 두었습니다. **`citydata_ppltn_daily`** (장소별  |
| 28 | citydata_ppltn_demographics | 이 장소는 어떤 성별·나이대가 언제 몰립니까? | list_products → describe_product → preview_product → query_product | 되물음 | 질문("이 장소는 어떤 성별·나이대가 언제 몰립니까?")에 특정 장소가 지정되지 않아, `citydata_ppltn_demographics` 데이터(장소·요일·시간대별 방문객 성별·나이대 패턴, 집계 기준 2026- |
| 29 | citydata_ppltn_dow_hour | 이 장소는 무슨 요일 몇 시가 붐빕니까? | list_products → describe_product → preview_product | 되물음 | 어느 장소를 말씀하시는지 알려주시면 바로 조회해 드릴 수 있습니다. 이 대화에서 아직 특정 장소가 언급되지 않아 "이 장소"가 어디인지 확인이 필요합니다. 서울시 주요 장소(POI) 단위로 요일×시간대별 평균 인구· |
| 30 | citydata_ppltn_hourly | 이 장소는 몇 시에 붐비고 몇 시에 한산합니까? | list_products → describe_product → preview_product | 되물음 | 어떤 장소를 말씀하시는지 알려주시면 바로 조회해 드릴 수 있습니다. 이 대화에는 아직 특정 장소가 지정되어 있지 않아서요. 확인해 보니 서울시 실시간 도시데이터 기반의 **요일×시간대 혼잡 패턴 데이터**(`city |
| 31 | citydata_ppltn_x_culture_daily | 이 동네는 문화행사가 유동인구와 어떻게 맞물립니까? | list_products → describe_product → preview_product → query_product → run_pattern | 발산(max-turns) | 툴 반복 호출만 하고 답을 못 마침 |
| 32 | citydata_ppltn_x_weather_hourly | 날씨가 이 동네 붐빔에 어떻게 영향을 줍니까? | list_products → describe_product → preview_product → query_product | 정상 | 분석 에이전트가 데이터 집계를 마무리하는 중입니다. 완료 알림이 오면 결과를 정리해 드리겠습니다. |
| 33 | citydata_purchasing_power_daily | 이 장소는 유동인구가 실제 소비로 잘 이어집니까? | list_products → describe_product → run_pattern | 되물음 | 어느 장소를 말씀하시는지 지정되지 않아, 우선 서울시 전체 장소의 최신 데이터(2026-08-07 기준, `citydata_purchasing_power_daily` — 결제금액 ÷ 평균 유동인구로 산출한 구매력 지 |
| 34 | citydata_sbike_dow_hour | 이 장소는 무슨 요일 몇 시에 따릉이가 많습니까? | list_products → describe_product → preview_product → run_pattern | 되물음 | 질문이 인코딩이 깨진 채 도착했지만 **"이 장소는 무슨 요일 몇 시에 따릉이가 많습니까?"** 로 읽고 진행했습니다. 서울 데이터에 정확히 이 질문에 답하는 제품(`citydata_sbike_dow_hour` —  |
| 35 | citydata_transit_x_incident_hourly | 이 동네는 언제 교통이 막히고 돌발이 잦습니까? | list_products → describe_product → preview_product | 정상 | 동네 이름을 알려주시면 바로 조회해 드릴 수 있습니다. 질문에 "이 동네"라고 하셨는데, 어느 동네(행정동 기준, 예: "서초3동" 또는 "강서구 등촌2동")인지가 대화에 없어서 조회를 시작할 수가 없습니다. 참고로 |
| 36 | culture_activity_by_dong | 어느 행정동에서 언제 문화 활동이 얼마나 열리나? | list_products → describe_product → check_quota → query_product → run_pattern | 발산(max-turns) | 툴 반복 호출만 하고 답을 못 마침 |
| 37 | culture_booking_curve | 공연 예매 인기가 개막까지 어떤 궤적으로 차오르나? | list_products → describe_product → query_product | 정상 | 셸 실행이 전부 승인 대기로 막혀 있어, 99건 전량을 받아둔 데이터로 직접 집계했습니다. 결과를 정리합니다. ## 결론: 궤적은 하나가 아니라 두 갈래입니다 `culture_booking_curve`(KOPIS 예 |
| 38 | culture_boxoffice_daily | 지금 서울에서 예매 상위 공연은 무엇인가? | list_products | 미실행(세션 한도) | — |
| 39 | culture_calendar_density | 구별로 어느 날짜에 행사가 몰리나(밀집도)? | — | 미실행(세션 한도) | — |
| 40 | culture_dine_around | 행사 많은 동네 주변 외식 상권은 어디인가? | — | 미실행(세션 한도) | — |
| 41 | culture_event_crowd | 무슨 요일 몇 시에 행사 주변이 붐비나? | — | 미실행(세션 한도) | — |
| 42 | culture_event_schedule | 이번 주말·특정 기간 서울에서 무슨 문화행사가 열리나? | — | 미실행(세션 한도) | — |
| 43 | traffic_flow_anomaly_current | 각 도로 링크의 최신 속도는 같은 요일·시간대의 평소 범위와 비교해 어떻습니까? | — | 미실행(세션 한도) | — |
| 44 | traffic_flow_change_latest | 각 도로 링크의 최신 속도와 통행시간은 직전 관측보다 어떻게 바뀌었습니까? | — | 미실행(세션 한도) | — |
| 45 | traffic_flow_congestion_hotspots_hourly | 특정 시간에 관측 속도가 가장 낮은 링크는 어디입니까? | — | 미실행(세션 한도) | — |
| 46 | traffic_flow_link_latest | 각 도로 링크의 가장 최근 속도와 통행시간은 무엇입니까? | — | 미실행(세션 한도) | — |
| 47 | traffic_flow_link_time_profile | 이 도로 링크는 같은 요일과 시간대에 보통 어느 정도 속도로 관측됩니까? | — | 미실행(세션 한도) | — |
| 48 | traffic_incident_x_weather_current_hourly | 돌발이 있는(또는 없는) 서울 행정동의 같은 평가 시간 KMA 예보 맥락은 무엇입니까? | — | 미실행(세션 한도) | — |
| 49 | transit_dong_hourly | 이 행정동은 시간대별로 교통 상태가 어떠했습니까? | — | 미실행(세션 한도) | — |
| 50 | transit_dong_now | 지금 이 행정동의 버스·지하철·주차 상태는 어떻습니까? | — | 미실행(세션 한도) | — |
| 51 | transit_event_access | 이 문화행사에 대중교통이나 자차로 어떻게 갑니까? | — | 미실행(세션 한도) | — |
| 52 | transit_parking_full_risk | 지금 이 주차장은 얼마나 찼고 만차까지 얼마나 남았습니까? | — | 미실행(세션 한도) | — |
| 53 | weather_place_current_outlook | 지금 이 장소의 가장 가까운 기상 예보는 무엇입니까? | — | 미실행(세션 한도) | — |
| 54 | weather_place_forecast_change_daily | 특정 장소의 일별 예보는 직전 KMA 발표보다 어떻게 바뀌었습니까? | — | 미실행(세션 한도) | — |
| 55 | weather_place_precipitation_window | 특정 장소에서 비나 눈이 연속으로 예보된 시간대는 언제입니까? | — | 미실행(세션 한도) | — |
| 56 | weather_place_risk_window | 특정 장소에서 방문·이동 주의가 필요할 수 있는 예보 시간과 근거는 무엇입니까? | — | 미실행(세션 한도) | — |