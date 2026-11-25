/**
 * Vietnamese strings, keyed by the English sentence they replace.
 *
 * The key is the English text itself, so this file is the only place a
 * translation lives and `t("Monitor")` needs no id to look up. `t()` falls back
 * to the key when a sentence is missing here, which means a gap shows as
 * English in the Vietnamese build rather than as a broken token -- visible, and
 * caught by `pipeline/check_i18n.py` before it reaches a screenshot.
 *
 * Conventions, so the two languages read as one product rather than a
 * translation:
 *
 *   * clinical terms stay in their standard form where a Vietnamese clinician
 *     would read the abbreviation anyway: R-R, QRS, PQRST, HRV, SDNN, RMSSD,
 *     LF/HF, BPM, ms, Hz. Spelling them out would make the panel longer and
 *     less familiar, not clearer.
 *   * the class letters N / S / V / Q are never translated; their names are.
 *   * sentence fragments ("Put the dataset in a") are separate keys so a
 *     `<span class="mono">` can sit between them, and Vietnamese word order is
 *     preserved by the pieces chosen here.
 *   * `×` and `…` are kept as they are; they are not words.
 *
 * Placeholders are `{name}` and must match the English key exactly; that is
 * checked.
 */
export const VI: Record<string, string> = {
  // ---- navigation and shell ------------------------------------------------
  Monitor: "Màn hình",
  "AI Model": "Mô hình AI",
  Docs: "Hướng dẫn",
  Language: "Ngôn ngữ",
  "local dataset": "dữ liệu cục bộ",
  "Icentia11k · local": "Icentia11k · cục bộ",
  "On this page": "Trong trang này",
  Close: "Đóng",
  "Switch to the light theme": "Chuyển sang giao diện sáng",
  "Switch to the dark theme": "Chuyển sang giao diện tối",
  "Light theme": "Giao diện sáng",
  "Dark theme": "Giao diện tối",

  // ---- loading and errors --------------------------------------------------
  "Reading {what}…": "Đang đọc {what}…",
  "Cannot read {what}": "Không đọc được {what}",
  "Loading segment…": "Đang tải đoạn ghi…",
  "Cannot load the dataset": "Không tải được bộ dữ liệu",
  "Put the dataset in a": "Hãy đặt bộ dữ liệu trong thư mục",
  "Start the app with": "Khởi động ứng dụng bằng",
  from: "từ",
  "; the Vite middleware serves /data from": "; middleware Vite phục vụ /data từ",
  "These pages read the same": "Các trang này đọc cùng",
  "folder as the monitor. In a browser,": "thư mục với màn hình chính. Trên trình duyệt,",
  "serves it at": "phục vụ thư mục đó tại",
  "; in the packaged app it must sit beside the executable, in":
    "; trong bản đóng gói, thư mục này phải nằm cạnh tệp thực thi, tại",
  ", or at the path in": ", hoặc tại đường dẫn trong",

  // ---- the left rail -------------------------------------------------------
  Segments: "Danh sách đoạn",
  "Hide Segments": "Ẩn danh sách đoạn",
  "Show Beats": "Hiện nhịp",
  "Hide Beats": "Ẩn nhịp",
  "Detect R-peaks": "Dò đỉnh R",
  "Detecting…": "Đang dò…",
  "Hide Detected Peaks": "Ẩn đỉnh đã dò",
  "Detector failed": "Bộ dò lỗi",
  "Delineate PQRST": "Phân định PQRST",
  "Delineating…": "Đang phân định…",
  "Hide PQRST": "Ẩn PQRST",
  "Delineation failed": "Phân định lỗi",
  Vitals: "Chỉ số sống",
  "Hide Vitals": "Ẩn chỉ số sống",
  "AI Beat Classifier": "Bộ phân loại nhịp AI",
  "Hide AI Classifier": "Ẩn bộ phân loại AI",
  "Classifying…": "Đang phân loại…",
  "Classifier failed": "Bộ phân loại lỗi",
  HRV: "HRV",
  "Hide HRV": "Ẩn HRV",
  "Session Report": "Báo cáo phiên",
  "Hide Session": "Ẩn phiên ghi",
  "Light Mode": "Chế độ sáng",
  "Dark Mode": "Chế độ tối",

  // ---- transport -----------------------------------------------------------
  "Pause (Space)": "Tạm dừng (Space)",
  "Play (Space)": "Phát (Space)",
  Pause: "Tạm dừng",
  Play: "Phát",
  Seek: "Tua",
  "Previous beat": "Nhịp trước",
  "Previous beat (Shift+Left)": "Nhịp trước (Shift+←)",
  "Next beat": "Nhịp sau",
  "Next beat (Shift+Right)": "Nhịp sau (Shift+→)",
  "Back 10 seconds": "Lùi 10 giây",
  "Back 10 s (Left)": "Lùi 10 s (←)",
  "Forward 10 seconds": "Tiến 10 giây",
  "Forward 10 s (Right)": "Tiến 10 s (→)",
  "Playback speed": "Tốc độ phát",

  // ---- segment picker ------------------------------------------------------
  Dataset: "Bộ dữ liệu",
  "Icentia11k · {n} segments · {p} patients · 250 Hz":
    "Icentia11k · {n} đoạn · {p} bệnh nhân · 250 Hz",
  "Patient {id}": "Bệnh nhân {id}",
  "{n} beats": "{n} nhịp",
  "{n} min": "{n} phút",

  // ---- the dataset folder --------------------------------------------------
  "Dataset folder": "Thư mục dữ liệu",
  unknown: "chưa rõ",
  "Missing from this folder: {files}": "Thiếu trong thư mục này: {files}",
  "Choose folder…": "Chọn thư mục…",
  "Use default": "Dùng mặc định",
  "The dev server reads this folder; restart it with RPEAK_DATA_DIR to change it.":
    "Máy chủ phát triển đọc thư mục này; khởi động lại với RPEAK_DATA_DIR để đổi.",
  "folder next to the installed app, or use the button above.":
    "thư mục cạnh bản cài, hoặc dùng nút ở trên.",
  "environment variable": "biến môi trường",
  chosen: "đã chọn",
  "beside the app": "cạnh ứng dụng",
  "user data folder": "thư mục dữ liệu người dùng",
  "repository (dev)": "kho mã (phát triển)",
  "not found": "không tìm thấy",
  "RPEAK_DATA_DIR is set, so it overrides the folder you chose earlier.":
    "RPEAK_DATA_DIR đang được đặt nên nó ghi đè thư mục bạn đã chọn trước đó.",
  "The folder you chose earlier is gone: {path}. Using the next location instead.":
    "Thư mục bạn chọn trước đó không còn tồn tại: {path}. Đang dùng vị trí kế tiếp.",

  // ---- vitals panel --------------------------------------------------------
  Source: "Nguồn",
  "Live detector · {ms} ms": "Bộ dò trực tiếp · {ms} ms",
  "Reference annotations": "Nhãn tham chiếu",
  "Heart rate": "Nhịp tim",
  "Median of the last 12 s of R-R intervals": "Trung vị R-R trong 12 s gần nhất",
  "Beats so far": "Số nhịp đã qua",
  Intervals: "Khoảng thời gian",
  "nearest beat": "nhịp gần nhất",
  "PQRST off": "PQRST đang tắt",
  "Segment median PR {pr} · QRS {qrs} · QT {qt} ms · {n} beats in {ms} ms":
    "Trung vị đoạn: PR {pr} · QRS {qrs} · QT {qt} ms · {n} nhịp trong {ms} ms",
  " No P found on {pct}% of beats.": " Không tìm thấy P ở {pct}% số nhịp.",
  "Turn on PQRST in the left rail to measure P, QRS and T boundaries.":
    "Bật PQRST ở thanh bên trái để đo ranh giới P, QRS và T.",
  "Beat classes": "Nhóm nhịp",
  " (reference)": " (tham chiếu)",
  Normal: "Bình thường",
  Supraventricular: "Trên thất",
  Ventricular: "Thất",
  Unclassifiable: "Không phân loại được",
  Segment: "Đoạn ghi",
  "Mean HR (segment)": "Nhịp tim TB (đoạn)",
  Quality: "Chất lượng",
  // `pipeline/convert.py`'s coarse signal-quality label, which the catalogue
  // stores as an ASCII value ("low-amplitude"): the value is a key, not prose.
  "Normal signal": "Tín hiệu bình thường",
  Saturated: "Bão hoà",
  "Low amplitude": "Biên độ thấp",
  "Flat / disconnected": "Phẳng / mất kết nối",
  "Implausible heart rate": "Nhịp tim bất thường",
  "Detector F1": "F1 của bộ dò",
  "R-R and heart rate come from the detector running in a worker over the whole segment. Beat classes are the reference labels; the detector does not classify.":
    "R-R và nhịp tim lấy từ bộ dò chạy trong worker trên toàn đoạn. Nhóm nhịp là nhãn tham chiếu; bộ dò không phân loại.",
  "Vitals come from the reference annotations shipped with the dataset. Turn on the detector in the left rail to compare.":
    "Chỉ số sống lấy từ nhãn tham chiếu đi kèm bộ dữ liệu. Bật bộ dò ở thanh bên trái để so sánh.",

  // ---- error boundaries ----------------------------------------------------
  "This panel stopped working": "Bảng này ngừng hoạt động",
  "The app stopped working": "Ứng dụng ngừng hoạt động",
  "{what} hit an error while drawing. The rest of the app keeps running.":
    "{what} gặp lỗi khi vẽ. Phần còn lại của ứng dụng vẫn chạy.",
  "Something in the app threw while drawing. Reloading usually clears it.":
    "Có lỗi xảy ra khi ứng dụng đang vẽ. Tải lại thường sẽ hết.",
  "the vitals panel": "bảng chỉ số sống",
  "the HRV panel": "bảng HRV",
  "the session panel": "bảng phiên ghi",
  "the classifier panel": "bảng phân loại",
  "the dataset panel": "bảng bộ dữ liệu",
  "the model card": "trang mô hình AI",
  "the guide": "trang hướng dẫn",
  "the monitor": "màn hình theo dõi",
  "Try again": "Thử lại",
  Reload: "Tải lại",
  "This link names a segment that is not loaded.": "Liên kết này trỏ tới một đoạn chưa được nạp.",
  "Open the list": "Mở danh sách",

  // ---- HRV panel -----------------------------------------------------------
  "Waiting for detector…": "Đang chờ bộ dò…",
  "R-R tachogram": "Tachogram R-R",
  "R-R spectrum": "Phổ R-R",
  "4 Hz tachogram": "tachogram 4 Hz",
  "Mean R-R": "R-R trung bình",
  Irregular: "Không đều",
  "Spectrum unavailable: it needs 20 intervals spanning at least 30 s.":
    "Không có phổ: cần 20 khoảng R-R trải trên ít nhất 30 s.",
  "{kept} kept · {gated} gated": "giữ {kept} · loại {gated}",
  "Analysed span": "Khoảng phân tích",
  Resolution: "Độ phân giải",
  "Bands: VLF 0.003-0.04, LF 0.04-0.15, HF 0.15-0.40 Hz. Intervals outside 300-2000 ms are gated, not interpolated.":
    "Dải: VLF 0.003-0.04, LF 0.04-0.15, HF 0.15-0.40 Hz. Khoảng R-R nằm ngoài 300-2000 ms bị loại, không nội suy.",
  "HRV needs at least four valid R-R intervals; the spectrum needs twenty intervals spanning 30 s.":
    "HRV cần ít nhất bốn khoảng R-R hợp lệ; phổ cần hai mươi khoảng trải trên 30 s.",
  "No peaks yet.": "Chưa có đỉnh nào.",
  "fewer than 4 peaks": "ít hơn 4 đỉnh",
  "fewer than 4 valid intervals": "ít hơn 4 khoảng R-R hợp lệ",

  // ---- classifier panel ----------------------------------------------------
  "Loading the model…": "Đang tải mô hình…",
  "Classifying beats…": "Đang phân loại nhịp…",
  "Classifier is off.": "Bộ phân loại đang tắt.",
  // The hooks' own diagnostics, shown as the panel's error and in the App.
  "the classification worker failed": "worker phân loại gặp lỗi",
  "the delineation worker failed": "worker phân định gặp lỗi",
  "the detection worker failed": "worker dò đỉnh gặp lỗi",
  "no model at data/models/beatcnn.json": "không tìm thấy mô hình ở data/models/beatcnn.json",
  "model file is not a beat CNN export": "tệp mô hình không phải bản xuất beat CNN",
  "The catalogue is empty. Run pipeline/export_app_index.py.":
    "Danh mục trống. Hãy chạy pipeline/export_app_index.py.",
  "{n} beats ·": "{n} nhịp ·",
  " · live detector peaks": " · đỉnh từ bộ dò trực tiếp",
  " · reference annotation peaks": " · đỉnh từ nhãn tham chiếu",
  Class: "Nhóm",
  Beats: "Số nhịp",
  Share: "Tỉ lệ",
  "Mean p": "p trung bình",
  "Beat at the playhead": "Nhịp tại con trỏ phát",
  "No beat at the playhead.": "Không có nhịp tại con trỏ phát.",
  "Supraventricular ectopic": "Ngoại tâm thu trên thất",
  "Ventricular ectopic": "Ngoại tâm thu thất",

  // ---- session report ------------------------------------------------------
  Session: "Phiên ghi",
  "Start session": "Bắt đầu phiên ghi",
  "Stop & build report": "Dừng & lập báo cáo",
  "Whole segment": "Cả đoạn ghi",
  Recording: "Đang ghi",
  From: "Từ",
  "Signal elapsed": "Thời gian tín hiệu",
  "Wall elapsed": "Thời gian thực",
  "Play or scrub the trace, then stop. The report covers the signal span between start and stop.":
    "Phát hoặc tua tín hiệu rồi dừng. Báo cáo chỉ tính khoảng tín hiệu giữa lúc bắt đầu và lúc dừng.",
  "Delineating PQRST for the interval columns…":
    "Đang phân định PQRST cho các cột khoảng thời gian…",
  "Report · {record}": "Báo cáo · {record}",
  Span: "Khoảng",
  "Beats in span": "Số nhịp trong khoảng",
  "R-R range": "Miền R-R",
  "Median PR/QRS/QT": "Trung vị PR/QRS/QT",
  "SDNN / RMSSD": "SDNN / RMSSD",
  "not measured": "chưa đo",
  Classes: "Các nhóm",
  "Beats CSV": "CSV từng nhịp",
  "Report JSON": "JSON báo cáo",
  "CSV: one row per beat with R-R and PQRST intervals. JSON: the summary above plus the conventions used. Both are written to your downloads folder.":
    "CSV: mỗi dòng một nhịp kèm R-R và các khoảng PQRST. JSON: bản tóm tắt ở trên cùng các quy ước đã dùng. Cả hai được ghi vào thư mục tải về của bạn.",
  "No report yet. Start a session and stop it, or report the whole segment.":
    "Chưa có báo cáo. Hãy bắt đầu một phiên rồi dừng, hoặc lập báo cáo cho cả đoạn.",
  " Load a segment first.": " Hãy tải một đoạn ghi trước.",
  "The playhead has not moved past the start of the session yet.":
    "Con trỏ phát chưa vượt qua điểm bắt đầu của phiên ghi.",
  detector: "bộ dò",
  annotations: "nhãn tham chiếu",
  "Live detector": "Bộ dò trực tiếp",

  // ---- charts --------------------------------------------------------------
  "Use the arrow keys to read values, shift for ten at a time, Page Up and Page Down for ten at a time, Home and End for the ends, Escape to clear.":
    "Dùng các phím mũi tên để đọc giá trị, giữ Shift để nhảy mười bước, Page Up và Page Down cũng nhảy mười bước, Home và End tới hai đầu, Escape để xoá con trỏ.",
  "Use the arrow keys to move between patients and measures, shift or Page Up and Page Down for ten patients at a time, Home and End for the first and last patient, Escape to clear.":
    "Dùng các phím mũi tên để di chuyển giữa bệnh nhân và thước đo, giữ Shift hoặc Page Up, Page Down để nhảy mười bệnh nhân, Home và End tới bệnh nhân đầu và cuối, Escape để xoá con trỏ.",
  "{i} of {n}": "{i}/{n}",
  "Rows: annotated class · columns: prediction": "Hàng: nhóm được gán · cột: nhóm dự đoán",
  "true ↓": "thực ↓",
  "true {a} → predicted {b}: {v} ({pct}% of {a} beats)":
    "thực {a} → dự đoán {b}: {v} ({pct}% số nhịp {a})",
  Counts: "Số lượng",
  "Row %": "Tỉ lệ hàng",

  // ---- docs: header --------------------------------------------------------
  "Rpeak Desktop · Docs": "Rpeak Desktop · Hướng dẫn",
  "Rpeak — User Guide": "Rpeak — Hướng dẫn sử dụng",
  "A local desktop rebuild of the Rpeak ECG monitor, running on the PhysioNet Icentia11k continuous ECG dataset. This guide covers what the app does, how to read its numbers, and where its limits are.":
    "Bản dựng lại chạy cục bộ của màn hình theo dõi ECG Rpeak, trên bộ dữ liệu ECG liên tục Icentia11k của PhysioNet. Hướng dẫn này nói ứng dụng làm gì, đọc các con số của nó thế nào, và giới hạn nằm ở đâu.",
  "the evaluation artefacts": "các tệp đánh giá",

  // ---- docs: start here ----------------------------------------------------
  "Start here": "Bắt đầu từ đây",
  "Rpeak reads a dataset folder; it does not ship one. Everything below assumes the repository layout.":
    "Rpeak đọc một thư mục dữ liệu chứ không kèm sẵn dữ liệu. Phần dưới đây giả định cách bố trí của kho mã.",
  "Run it": "Chạy ứng dụng",
  "browser build at http://localhost:5173": "bản chạy trên trình duyệt tại http://localhost:5173",
  "the same app in a Tauri window": "cùng ứng dụng đó trong cửa sổ Tauri",
  "rpeak.exe + the NSIS installer": "rpeak.exe + bộ cài NSIS",
  "drive the live page over CDP": "điều khiển trang đang chạy qua CDP",
  "All commands run from": "Mọi lệnh chạy từ",
  "The browser build serves": "Bản chạy trên trình duyệt phục vụ",
  at: "tại",
  "through Vite middleware.": "qua middleware Vite.",
  "Where the packaged app looks for the dataset": "Bản đóng gói tìm dữ liệu ở những đâu",
  ", if set.": ", nếu được đặt.",
  "beside the executable.": "cạnh tệp thực thi.",
  "The dataset is 1.1 GB and carries its own licence, so it is deliberately not bundled. When nothing is found the app still opens and names every folder it searched.":
    "Bộ dữ liệu nặng 1,1 GB và có giấy phép riêng, nên cố ý không đóng gói kèm. Khi không tìm thấy gì, ứng dụng vẫn mở và liệt kê mọi thư mục đã tìm.",
  "Deep link: segment and moment": "Liên kết sâu: đoạn ghi và thời điểm",
  "Deep link: open a panel": "Liên kết sâu: mở một bảng",
  "Pin a theme": "Ghim giao diện",
  "Open a page": "Mở một trang",

  // ---- docs: the monitor ---------------------------------------------------
  "The monitor": "Màn hình theo dõi",
  "The trace is a 1,000-sample window — four seconds at 250 Hz — scrolling through the display filter chain. Beat annotations from the dataset are drawn over it: a colour-coded dot at each R peak, a faint baseline tick, and a letter for the abnormal classes only.":
    "Đường tín hiệu là cửa sổ 1.000 mẫu — bốn giây ở 250 Hz — cuộn qua chuỗi lọc hiển thị. Nhãn nhịp từ bộ dữ liệu được vẽ đè lên: một điểm mã hoá màu ở mỗi đỉnh R, một vạch mờ ở đường nền, và chữ cái chỉ cho các nhóm bất thường.",
  Transport: "Điều khiển phát",
  "Play/pause, skip back and forward, beat-step, a seek slider and four speeds (1×, 4×, 16×, 60×). The left rail expands on hover: segments, beat overlay, detector, delineation, vitals, HRV, session, classifier, theme.":
    "Phát/tạm dừng, lùi và tiến, nhảy từng nhịp, thanh tua và bốn tốc độ (1×, 4×, 16×, 60×). Thanh bên trái mở ra khi rê chuột: đoạn ghi, lớp nhịp, bộ dò, phân định, chỉ số sống, HRV, phiên ghi, bộ phân loại, giao diện.",
  Keyboard: "Bàn phím",
  "play / pause": "phát / tạm dừng",
  "seek ∓5 s": "tua ∓5 s",
  "step one beat": "nhảy một nhịp",
  "speed 1× / 4× / 16× / 60×": "tốc độ 1× / 4× / 16× / 60×",
  "The address bar tracks the segment and the playhead whenever playback stops, so a paused view is a shareable link. A partly filled window is left blank rather than padded — a flat line at the left edge would read as signal.":
    "Thanh địa chỉ ghi lại đoạn ghi và con trỏ phát mỗi khi dừng phát, nên một khung hình đang tạm dừng là một liên kết chia sẻ được. Cửa sổ chưa đầy được để trống chứ không độn thêm — một đường phẳng ở mép trái sẽ bị đọc thành tín hiệu.",

  // ---- docs: analysis tools ------------------------------------------------
  "Analysis tools": "Công cụ phân tích",
  "Each tool runs on the peak set the rest of the app is using: the live detector when it is on, the reference annotations otherwise. The source is always named in the panel.":
    "Mỗi công cụ chạy trên tập đỉnh mà phần còn lại của ứng dụng đang dùng: bộ dò trực tiếp khi bật, ngược lại là nhãn tham chiếu. Bảng luôn ghi rõ nguồn.",
  "Segment browser": "Duyệt đoạn ghi",
  "Twenty-four catalogued segments across twelve patients. Each row carries the reference beat count and the detector's F1 on that segment, so a bad recording is visible before you open it.":
    "Hai mươi bốn đoạn ghi trong danh mục, thuộc mười hai bệnh nhân. Mỗi dòng có số nhịp tham chiếu và F1 của bộ dò trên đoạn đó, nên một bản ghi kém hiện ra trước khi bạn mở nó.",
  "24 segments · 12 patients": "24 đoạn · 12 bệnh nhân",
  "R-peak detection": "Dò đỉnh R",
  "The green rail toggle runs detect_v4 — the Python reference's algorithm, ported to TypeScript — over the whole segment in a worker. Peaks appear as hollow blue rings and top-edge triangles. The trace keeps playing while it runs.":
    "Nút màu xanh ở thanh bên chạy detect_v4 — thuật toán của bản tham chiếu Python, chuyển sang TypeScript — trên toàn đoạn ghi trong một worker. Đỉnh hiện ra dưới dạng vòng xanh rỗng và tam giác ở mép trên. Tín hiệu vẫn phát trong lúc chạy.",
  "Se 97.73 · PPV 96.21": "Se 97,73 · PPV 96,21",
  "PQRST delineation": "Phân định PQRST",
  "The yellow toggle finds P, QRS and T boundaries around the same peak set and draws them in a caliper lane under the trace. The Vitals panel reads its intervals.":
    "Nút màu vàng tìm ranh giới P, QRS và T quanh cùng tập đỉnh đó và vẽ chúng ở làn thước kẹp dưới tín hiệu. Bảng Chỉ số sống đọc các khoảng thời gian này.",
  "91 ms per 6,885-beat segment": "91 ms cho đoạn 6.885 nhịp",
  "Heart-rate variability": "Biến thiên nhịp tim",
  "The cyan panel plots the R-R tachogram and its spectrum, and reports SDNN, RMSSD, pNN50, LF, HF and LF/HF. Intervals outside 300–2000 ms are gated, not interpolated.":
    "Bảng màu lục lam vẽ tachogram R-R và phổ của nó, đồng thời báo SDNN, RMSSD, pNN50, LF, HF và LF/HF. Khoảng R-R ngoài 300–2000 ms bị loại, không nội suy.",
  "recomputed from the current peaks": "tính lại từ tập đỉnh hiện tại",
  "Session report": "Báo cáo phiên ghi",
  "The red entry records a span of the current segment and exports it as CSV (one row per beat, with class and intervals) or JSON (a summary). Both formats are plain text and carry the segment name and time base.":
    "Mục màu đỏ ghi lại một khoảng của đoạn hiện tại và xuất ra CSV (mỗi nhịp một dòng, kèm nhóm và các khoảng thời gian) hoặc JSON (bản tóm tắt). Cả hai định dạng đều là văn bản thuần và có tên đoạn ghi cùng gốc thời gian.",
  "CSV · JSON": "CSV · JSON",
  "AI beat classifier": "Bộ phân loại nhịp AI",
  "The purple entry classifies every beat as N, S, V or Q in a worker and reports per-class counts, shares and mean confidence, plus the full distribution for the beat at the playhead.":
    "Mục màu tím phân loại từng nhịp thành N, S, V hoặc Q trong một worker và báo số lượng, tỉ lệ và độ tin cậy trung bình theo từng nhóm, cùng toàn bộ phân bố của nhịp tại con trỏ phát.",
  "≈1 ms per beat": "≈1 ms mỗi nhịp",

  // ---- docs: the numbers ---------------------------------------------------
  "Understanding the numbers": "Hiểu các con số",
  "Detection is scored against the dataset's own R-peak annotations with a one-to-one, score-weighted match: two peaks match when they fall within":
    "Việc dò được chấm điểm so với chính nhãn đỉnh R của bộ dữ liệu, ghép một-một có trọng số điểm: hai đỉnh được coi là khớp khi cách nhau trong khoảng",
  "of each other. Se is recall, PPV is precision, F1 their harmonic mean.":
    "của nhau. Se là độ nhạy, PPV là độ chính xác dương tính, F1 là trung bình điều hoà của hai giá trị đó.",
  "Detector sensitivity": "Độ nhạy bộ dò",
  "{n} segments": "{n} đoạn",
  "Detector PPV": "PPV bộ dò",
  "Classifier accuracy": "Độ chính xác bộ phân loại",
  "Python parity": "Tương đương bản Python",
  "segments bit-identical": "đoạn giống hệt từng bit",
  "Detector Se and PPV by patient": "Se và PPV của bộ dò theo bệnh nhân",
  Sensitivity: "Độ nhạy",
  PPV: "PPV",
  "Sensitivity and positive predictive value per patient":
    "Độ nhạy và giá trị dự báo dương tính theo từng bệnh nhân",
  Patient: "Bệnh nhân",
  Se: "Se",
  F1: "F1",
  "All segments": "Tất cả các đoạn",
  "The spread is the useful part: six of twelve patients sit above 98% on both measures, while p00006 (Se 94.16, PPV 87.90) and p00004 (95.96 / 93.60) carry most of the loss. Detection is whole-segment and not streaming — switching segments re-runs it, which is why the rings appear a moment after the trace.":
    "Phần hữu ích chính là độ phân tán: sáu trong mười hai bệnh nhân đạt trên 98% ở cả hai thước đo, trong khi p00006 (Se 94,16, PPV 87,90) và p00004 (95,96 / 93,60) gánh phần lớn phần mất. Việc dò chạy trên toàn đoạn chứ không theo luồng — đổi đoạn là chạy lại, nên các vòng hiện ra sau tín hiệu một lát.",
  "Beat classifier, held-out patients": "Bộ phân loại nhịp, trên bệnh nhân giữ riêng",
  Meaning: "Ý nghĩa",
  Support: "Số mẫu",
  "Q is not a rhythm: in icentia11k it means “unclassifiable beat”. The full confusion matrix, the training curve and the PyTorch parity check are on the AI Model page.":
    "Q không phải một loại nhịp: trong icentia11k nó nghĩa là “nhịp không phân loại được”. Ma trận nhầm lẫn đầy đủ, đường cong huấn luyện và phép kiểm tra tương đương PyTorch nằm ở trang Mô hình AI.",
  "Open AI Model →": "Mở Mô hình AI →",

  // ---- docs: performance ---------------------------------------------------
  Performance: "Hiệu năng",
  "Measured on this machine against the 24 catalogued segments. The heavy jobs run in workers, so playback continues while they finish.":
    "Đo trên chính máy này với 24 đoạn trong danh mục. Các việc nặng chạy trong worker, nên quá trình phát vẫn tiếp tục trong lúc chúng hoàn tất.",
  Job: "Công việc",
  Cost: "Chi phí",
  Where: "Chạy ở đâu",
  "685 ms median per segment (516–855 ms)": "trung vị 685 ms mỗi đoạn (516–855 ms)",
  "0.95–1.3 ms per beat · 6.5–9.1 s per segment": "0,95–1,3 ms mỗi nhịp · 6,5–9,1 s mỗi đoạn",
  "on demand, from the peak set": "theo yêu cầu, từ tập đỉnh",
  "main thread": "luồng chính",
  worker: "worker",
  instant: "tức thì",
  "Session report / export": "Báo cáo phiên / xuất tệp",
  "Beat classification": "Phân loại nhịp",

  // ---- docs: dataset and limits -------------------------------------------
  "Dataset and licence": "Bộ dữ liệu và giấy phép",
  "Everything the app shows comes from one public dataset. Nothing is synthetic, and nothing is recorded by the app.":
    "Mọi thứ ứng dụng hiển thị đều đến từ một bộ dữ liệu công khai. Không có gì là dữ liệu tổng hợp, và ứng dụng không tự ghi âm gì.",
  Licence: "Giấy phép",
  "Sampling rate": "Tần số lấy mẫu",
  Lead: "Đạo trình",
  "single chest lead": "một đạo trình ngực",
  "Segment length": "Độ dài đoạn",
  "1,048,577 samples · 69.9 min": "1.048.577 mẫu · 69,9 phút",
  Labels: "Nhãn",
  "N, S, V, Q — no F class": "N, S, V, Q — không có nhóm F",
  Catalogue: "Danh mục",
  "On disk": "Trên đĩa",
  "142 segments · 42 patients": "142 đoạn · 42 bệnh nhân",
  "The app reads pre-scaled float32 copies of each segment rather than decoding":
    "Ứng dụng đọc bản sao float32 đã chuẩn hoá sẵn của từng đoạn thay vì giải mã",
  "in the browser. The extra patients on disk exist so the classifier can hold out six patients by patient, never by window.":
    "ngay trên trình duyệt. Các bệnh nhân thừa trên đĩa có mặt để bộ phân loại giữ riêng sáu bệnh nhân theo bệnh nhân, không bao giờ theo cửa sổ.",
  "Limits and disclaimer": "Giới hạn và miễn trừ",
  // The table of contents uses a shorter label than the section heading.
  Limits: "Giới hạn",
  "The rebuild fixed defects; it did not turn a research prototype into a medical device.":
    "Bản dựng lại đã sửa các lỗi; nó không biến một nguyên mẫu nghiên cứu thành thiết bị y tế.",
  "Not a medical device.": "Không phải thiết bị y tế.",
  "No output here is a diagnosis, and none should be acted on.":
    "Không đầu ra nào ở đây là chẩn đoán, và không nên dựa vào chúng để hành động.",
  "The detector misses its 99% gate.": "Bộ dò chưa đạt ngưỡng 99%.",
  "Se 97.73 and PPV 96.21 against the annotations; the plan asked for 99% on both. The gap is stated rather than smoothed over.":
    "Se 97,73 và PPV 96,21 so với nhãn; kế hoạch đặt ra 99% cho cả hai. Khoảng thiếu được nêu ra chứ không làm mượt đi.",
  "The classifier is a demonstration.": "Bộ phân loại chỉ để minh hoạ.",
  "{pct} held-out accuracy, macro-F1 {f1}, and a fourth class that means “unusable” rather than a rhythm. It reads three RR ratios as well as the window; the ablation of that input is on the AI Model page.":
    "{pct} độ chính xác trên tập giữ riêng, macro-F1 {f1}, và nhóm thứ tư nghĩa là “không dùng được” chứ không phải một loại nhịp. Mô hình đọc cả ba tỉ số RR lẫn cửa sổ tín hiệu; phép loại bỏ đầu vào đó nằm ở trang Mô hình AI.",
  "Detection is whole-segment.": "Việc dò chạy trên toàn đoạn.",
  "A streaming detector needs a different algorithm, not a faster port: the selection dynamic program is global.":
    "Một bộ dò theo luồng cần thuật toán khác chứ không phải bản chuyển nhanh hơn: bài toán quy hoạch động chọn lọc ở đây là toàn cục.",
  "One platform, unsigned.": "Một nền tảng, chưa ký số.",
  "Windows x64 only; the installer is unsigned, so SmartScreen warns on first run, and WebView2 is a prerequisite.":
    "Chỉ Windows x64; bộ cài chưa ký số nên SmartScreen cảnh báo ở lần chạy đầu, và WebView2 là điều kiện bắt buộc.",
  "The engineering record lives in": "Hồ sơ kỹ thuật nằm trong",
  ": detector, analysis, classifier, app shell and packaging notes, each with the measurements behind the claims on this page.":
    ": ghi chú về bộ dò, phân tích, bộ phân loại, vỏ ứng dụng và đóng gói, mỗi phần kèm số đo đứng sau các khẳng định trên trang này.",
};
