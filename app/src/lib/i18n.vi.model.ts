/**
 * Vietnamese strings for the AI Model page.
 *
 * Split from `i18n.vi.ts` because the model card is a document of its own: it
 * carries the measurements, the ablation and the boundary study, and its
 * sentences are long. Keeping it in one file made every edit to either page a
 * search through the other.
 *
 * Same rules as the parent dictionary: the English sentence is the key, `{n}`
 * placeholders must survive unchanged, and clinical abbreviations (QRS, AUC,
 * MAC, argmax, logit) stay as they are.
 */
export const VI_MODEL: Record<string, string> = {
  // ---- the table of contents ----------------------------------------------
  // The TOC entries are shorter than the section headings, so they are keyed
  // separately: `t(s.title)` in PageShell looks up whatever the section list
  // holds, and that list is not the same string as the `<Section>` title.
  "The task, and what Q means": "Bài toán, và Q nghĩa là gì",
  Architecture: "Kiến trúc",
  "Does it use the cue?": "Mạng có dùng tín hiệu phụ không?",
  Training: "Huấn luyện",
  "Held-out evaluation": "Đánh giá trên tập giữ riêng",
  "Per patient": "Theo từng bệnh nhân",
  Parity: "Tương đương",
  "Inference cost": "Chi phí suy luận",
  "The N → Q boundary": "Ranh giới N → Q",
  "What it cannot see": "Những gì mô hình không thấy",

  // The section headings, which are longer because they carry the finding.
  "The task, and what Q actually means": "Bài toán, và Q thực sự nghĩa là gì",
  "Parity: PyTorch ↔ TypeScript": "Tương đương: PyTorch ↔ TypeScript",
  "The N → Q boundary, measured and not shipped":
    "Ranh giới N → Q, đã đo và không đưa vào sản phẩm",
  "What it still cannot see": "Những gì mô hình vẫn không thấy",

  // ---- header and tiles ----------------------------------------------------
  "Rpeak Desktop · AI Model": "Rpeak Desktop · Mô hình AI",
  "ECG Beat Classification Model Training": "Huấn luyện mô hình phân loại nhịp ECG",
  "A {n}-parameter convolutional network that reads one 250-sample window around an R peak, plus":
    "Mạng tích chập {n} tham số đọc một cửa sổ 250 mẫu quanh mỗi đỉnh R, cộng thêm",
  "and returns N, S, V or Q. It runs in the browser from":
    "và trả về N, S, V hoặc Q. Mô hình chạy ngay trong trình duyệt từ",
  "with a hand-written forward pass — no ONNX runtime, no WASM bundle.":
    "với một lượt lan truyền xuôi tự viết — không có runtime ONNX, không có gói WASM.",
  "the model artefacts": "các tệp mô hình",
  "Stored parameters": "Tham số lưu trữ",
  "{n} trained, incl. BatchNorm": "{n} đã huấn luyện, kể cả BatchNorm",
  "Held-out accuracy": "Độ chính xác trên tập giữ riêng",
  "macro-F1 {v}": "macro-F1 {v}",
  "Best epoch": "Epoch tốt nhất",
  "of {n}, early-stopped": "trong {n}, dừng sớm",
  Inference: "Suy luận",
  "ms/beat": "ms/nhịp",
  "6.5–9.1 s per segment": "6,5–9,1 s mỗi đoạn",

  // ---- the task ------------------------------------------------------------
  "Every R peak yields a 250-sample window — one second at 250 Hz, with the peak at sample 100 — normalised per beat by its own median and the 90th percentile of its core deviation. The network answers with one of the four groups AAMI EC57 defines. The fourth one is the reason this page exists.":
    "Mỗi đỉnh R cho ra một cửa sổ 250 mẫu — một giây ở 250 Hz, đỉnh nằm ở mẫu thứ 100 — được chuẩn hoá theo từng nhịp bằng trung vị của chính nó và bách phân vị 90 của độ lệch lõi. Mạng trả lời bằng một trong bốn nhóm mà AAMI EC57 định nghĩa. Nhóm thứ tư là lý do trang này tồn tại.",
  "Q is not a rhythm.": "Q không phải một loại nhịp.",
  "In icentia11k, Q is documented as": "Trong icentia11k, Q được mô tả là",
  "“undefined: unclassifiable beat”": "“không xác định: nhịp không phân loại được”",
  "The evidence agrees: Q beats occur in runs of up to 1,844 consecutive beats, their morphology correlation with a normal template has a median of 0.83 against 0.99 for N, and the signal around them is noisier. Q marks stretches where the annotator declined to label — movement artefact, a loose chest strap, a rhythm nobody would commit to. The model's fourth output is therefore":
    "Bằng chứng đồng tình: các nhịp Q xuất hiện thành chuỗi dài tới 1.844 nhịp liên tiếp, tương quan hình thái của chúng với mẫu bình thường có trung vị 0,83 so với 0,99 của N, và tín hiệu quanh chúng nhiễu hơn. Q đánh dấu những đoạn mà người gán nhãn từ chối gán — nhiễu do cử động, dây đai ngực lỏng, một loại nhịp không ai dám khẳng định. Vì thế đầu ra thứ tư của mô hình là",
  "“this does not look like a usable beat”": "“nhịp này trông không dùng được”",
  ", and the monitor labels it": ", và màn hình gắn nhãn cho nó là",
  "It is not a diagnosis, and the per-class numbers below should be read with that in mind.":
    "Đó không phải một chẩn đoán, và các số theo từng nhóm ở dưới nên được đọc với điều đó trong đầu.",

  // ---- architecture --------------------------------------------------------
  "Three convolutional blocks, a global average pool and two dense layers. The receptive field is about 60 samples (240 ms), enough for the QRS width that separates V from N, and the whole network costs roughly 225k multiply-accumulates per window — the budget that keeps a 7,000-beat segment under seven seconds in a browser worker. The pooled vector is concatenated with":
    "Ba khối tích chập, một phép gộp trung bình toàn cục và hai lớp dày đặc. Trường tiếp nhận khoảng 60 mẫu (240 ms), đủ cho độ rộng QRS vốn phân biệt V với N, và toàn mạng tốn khoảng 225 nghìn phép nhân-cộng mỗi cửa sổ — mức ngân sách giữ một đoạn 7.000 nhịp dưới bảy giây trong worker của trình duyệt. Vector sau gộp được nối thêm",
  "{n} extra input": "{n} đầu vào phụ",
  "three timing ratios taken from the surrounding peaks — prematurity, the pause after it, and their average — because a beat's earliness is invisible inside its own second of signal":
    "ba tỉ số thời gian lấy từ các đỉnh xung quanh — độ sớm, khoảng nghỉ sau nó, và trung bình của hai giá trị đó — vì độ sớm của một nhịp không thể thấy được bên trong giây tín hiệu của chính nó",
  "the log of the amplitude the normalisation divides away":
    "logarit của biên độ mà phép chuẩn hoá chia đi",
  "before the head:": "trước phần đầu ra:",
  "The ablation below measures whether it uses": "Phép loại bỏ ở dưới đo xem mạng có dùng",
  it: "nó",
  them: "chúng",
  "{n} stored": "{n} lưu trữ",
  "1 s, R at 100": "1 s, R ở mẫu 100",
  Input: "Đầu vào",
  "Conv block 1": "Khối tích chập 1",
  "Conv block 2": "Khối tích chập 2",
  "Conv block 3": "Khối tích chập 3",
  "Global pool": "Gộp toàn cục",
  Concat: "Nối",
  Head: "Đầu ra",
  Pool: "Gộp",
  "Global average pool over time": "Gộp trung bình toàn cục theo thời gian",
  "Conv {i}": "Tích chập {i}",
  "Conv1d {a}→{b}, k={k}, same padding": "Conv1d {a}→{b}, k={k}, đệm giữ nguyên",
  "maxpool {p}": "gộp max {p}",
  "Dense {i}": "Dày đặc {i}",
  "Dense {a}→{b} · ReLU": "Dày đặc {a}→{b} · ReLU",
  "Dense {a}→{b} · logits": "Dày đặc {a}→{b} · logits",
  "Append standardised RR ratios (pre · post · sum)":
    "Nối thêm các tỉ số R-R đã chuẩn hoá (trước · sau · tổng)",
  "Append standardised log(scale)": "Nối thêm log(scale) đã chuẩn hoá",
  "RR ratios": "Tỉ số R-R",
  "pre · post · sum": "trước · sau · tổng",
  "log(scale)": "log(scale)",
  "ReLU · pool 4": "ReLU · gộp 4",
  "ReLU · pool 2": "ReLU · gộp 2",
  "mean over time": "trung bình theo thời gian",
  "ReLU · logits": "ReLU · logits",
  Stage: "Tầng",
  Operation: "Phép toán",
  Shape: "Kích thước",
  Stored: "Lưu trữ",
  "BatchNorm scale + shift during training (2 per channel), folded into one bias per channel at export":
    "BatchNorm scale + shift khi huấn luyện (2 giá trị mỗi kênh), gộp thành một bias mỗi kênh khi xuất",
  "Trained in PyTorch": "Huấn luyện trong PyTorch",
  "Both counts are right, and they count different things.":
    "Cả hai con số đều đúng, và chúng đếm hai thứ khác nhau.",
  "{n} parameters were trained;": "{n} tham số đã được huấn luyện;",
  "{n} are what the JSON carries. The convolutions have no bias while training because BatchNorm follows them, so each block's scale and shift — two values per output channel,":
    "{n} là những gì tệp JSON mang theo. Các phép tích chập không có bias khi huấn luyện vì BatchNorm đứng sau chúng, nên scale và shift của mỗi khối — hai giá trị mỗi kênh đầu ra,",
  "= {n} in all — are the only per-channel offsets. Folding collapses them into one bias per channel (":
    "= {n} tổng cộng — là những độ lệch mỗi kênh duy nhất. Phép gộp thu chúng thành một bias mỗi kênh (",
  "= {a}), which is why the stored count is exactly {b} lower. The runtime never has to remember whether normalisation runs before or after the activation.":
    "= {a}), đó là lý do số lưu trữ thấp hơn đúng {b}. Lúc chạy không bao giờ phải nhớ phép chuẩn hoá đứng trước hay sau hàm kích hoạt.",

  // ---- cue -----------------------------------------------------------------
  "The extra inputs exist because a 1 s window cannot hold everything a beat is. That is a hypothesis about the network, and it is testable without retraining: take the trained weights and feed them a constant, or the right values shuffled across beats. If the columns carry anything, both should hurt.":
    "Các đầu vào phụ có mặt vì cửa sổ 1 s không chứa được mọi thứ làm nên một nhịp. Đó là một giả thuyết về mạng, và có thể kiểm chứng mà không cần huấn luyện lại: lấy trọng số đã huấn luyện rồi nạp vào một hằng số, hoặc nạp đúng giá trị nhưng xáo trộn giữa các nhịp. Nếu các cột đó mang thông tin gì, cả hai cách đều phải làm hại.",
  "{label} fed to the head": "{label} nạp vào phần đầu ra",
  Accuracy: "Độ chính xác",
  "Macro-F1": "Macro-F1",
  "{c} F1": "F1 nhóm {c}",
  "The network uses it.": "Mạng có dùng nó.",
  "The network ignores it.": "Mạng bỏ qua nó.",
  "Replacing the column with a constant moves macro-F1 from":
    "Thay cột đó bằng một hằng số làm macro-F1 đi từ",
  to: "xuống",
  ", and shuffling it across beats to": ", và xáo trộn nó giữa các nhịp thì còn",
  "— a loss of": "— mất",
  "that the convolutional stack cannot recover, because the information is not in the window at all.":
    "mà chuỗi tích chập không thể lấy lại, vì thông tin đó hoàn toàn không nằm trong cửa sổ.",
  "No class moves by more than": "Không nhóm nào dịch quá",
  "in either direction, so the column is not carrying the decision.":
    "theo cả hai chiều, nên cột đó không mang quyết định.",
  "The cue itself is real and strong: on the held-out patients, prematurity alone separates S from N at AUC 0.930 and V from N at 0.985, and still 0.90–1.00 when the ratios are taken from detected peaks instead of annotations (":
    "Bản thân tín hiệu đó là thật và mạnh: trên các bệnh nhân giữ riêng, chỉ riêng độ sớm đã tách được S khỏi N ở AUC 0,930 và V khỏi N ở 0,985, và vẫn 0,90–1,00 khi các tỉ số được lấy từ đỉnh do bộ dò tìm ra thay vì từ nhãn (",
  "The cue is real (log(scale) alone separates Q from N at AUC 0.615) and still redundant here.":
    "Tín hiệu đó là thật (chỉ log(scale) đã tách Q khỏi N ở AUC 0,615) nhưng vẫn thừa ở đây.",
  "What the retrains actually changed": "Các lần huấn luyện lại thực sự thay đổi điều gì",
  Run: "Lần chạy",
  "Extra input": "Đầu vào phụ",
  none: "không",
  "Same data, same split, same seed.": "Cùng dữ liệu, cùng cách chia, cùng seed.",
  "Three extras were tried: none, log(scale) (G8) and the timing ratios (G9). The gap between the first row and the last is in the same direction as the ablation above, which is the difference between a plausible feature and a measured one — the ablation is the evidence, this table is the context.":
    "Ba phương án phụ đã được thử: không có gì, log(scale) (G8) và các tỉ số thời gian (G9). Khoảng cách giữa dòng đầu và dòng cuối cùng chiều với phép loại bỏ ở trên, và đó là khác biệt giữa một đặc trưng nghe hợp lý và một đặc trưng đã được đo — phép loại bỏ là bằng chứng, bảng này là bối cảnh.",
  "The spread across runs with and without the extra column is the run-to-run variance of this model on six held-out patients, not the value of the cue. The shipped model is the best of them; do not read the gap between the first and last row as a feature's contribution.":
    "Độ phân tán giữa các lần chạy có và không có cột phụ là phương sai giữa các lần chạy của mô hình này trên sáu bệnh nhân giữ riêng, không phải giá trị của tín hiệu phụ. Mô hình được phát hành là mô hình tốt nhất trong số đó; đừng đọc khoảng cách giữa dòng đầu và dòng cuối thành đóng góp của một đặc trưng.",
  "No ablation artefact — run": "Chưa có tệp loại bỏ — chạy",
  "to produce one.": "để tạo một tệp.",
  // The ablation's row names come from the artefact, so they are data rather
  // than sentences; translating them by key keeps the table readable without
  // rewriting the JSON on every run.
  real: "thực",
  shuffle: "xáo trộn",
  "zero (training mean)": "không (trung bình tập huấn luyện)",
  "zero pre_ratio": "không pre_ratio",
  "zero post_ratio": "không post_ratio",
  "zero sum_ratio": "không sum_ratio",

  // ---- training ------------------------------------------------------------
  "Twenty-four patients for training, six held out by patient — never by window, because adjacent beats from one 70-minute recording are near-duplicates and a window-level split reports memorisation as accuracy. Early stopping kept the checkpoint from epoch {n}.":
    "Hai mươi bốn bệnh nhân để huấn luyện, sáu bệnh nhân giữ riêng theo bệnh nhân — không bao giờ theo cửa sổ, vì các nhịp kề nhau trong một bản ghi 70 phút gần như trùng nhau và cách chia theo cửa sổ sẽ báo cáo sự học thuộc thành độ chính xác. Dừng sớm giữ lại checkpoint ở epoch {n}.",
  "Training loss": "Loss huấn luyện",
  "class-weighted cross-entropy": "cross-entropy có trọng số theo nhóm",
  Loss: "Loss",
  best: "tốt nhất",
  "Training loss by epoch, falling from 0.81 to 0.47":
    "Loss huấn luyện theo epoch, giảm từ 0,81 xuống 0,47",
  " · epoch": " · epoch",
  "Validation scores": "Điểm kiểm định",
  Acc: "Acc",
  "Validation accuracy and macro-F1 by epoch": "Độ chính xác kiểm định và macro-F1 theo epoch",
  "Best epoch {e}: accuracy": "Epoch tốt nhất {e}: độ chính xác",
  ", macro-F1": ", macro-F1",
  "The run continued to epoch {e} and stopped after eight epochs without a macro-F1 gain. The oscillation after epoch {b} is why the selection is on macro-F1 rather than on the loss, which never turned upward.":
    "Lần chạy tiếp tục tới epoch {e} rồi dừng sau tám epoch không cải thiện macro-F1. Dao động sau epoch {b} là lý do việc chọn dựa trên macro-F1 chứ không trên loss, vốn không bao giờ quay đầu tăng.",
  "AdamW · lr 2e-3 · weight decay 1e-4": "AdamW · lr 2e-3 · weight decay 1e-4",
  "CE weighted by inverse √frequency, mean 1":
    "CE có trọng số nghịch đảo √tần số, trung bình bằng 1",
  "cosine over {n} epochs": "cosine trong {n} epoch",
  "60,000 windows per class per epoch": "60.000 cửa sổ mỗi nhóm mỗi epoch",
  "8 epochs without macro-F1 gain": "8 epoch không cải thiện macro-F1",
  Optimiser: "Bộ tối ưu",
  Schedule: "Lịch học",
  "Class cap": "Giới hạn mỗi nhóm",
  Batch: "Batch",
  Dropout: "Dropout",
  "Early stop": "Dừng sớm",
  Seed: "Seed",
  "{label}, standardised before the head": "{label}, chuẩn hoá trước phần đầu ra",
  "Class balance and weights": "Cân bằng nhóm và trọng số",
  "Train / epoch": "Huấn luyện / epoch",
  Weight: "Trọng số",
  "Held-out": "Giữ riêng",
  "windows per epoch after the cap —": "cửa sổ mỗi epoch sau khi chặn —",
  "{r} records from {p} patients. The uncapped corpus is 522,652 windows; 65% of it is N from the same 24 people, and the 400,000th normal window teaches nothing while it does make two thirds of every epoch redundant.":
    "{r} bản ghi từ {p} bệnh nhân. Toàn bộ kho chưa chặn là 522.652 cửa sổ; 65% trong đó là N từ cùng 24 người, và cửa sổ bình thường thứ 400.000 không dạy thêm gì trong khi nó làm hai phần ba mỗi epoch thành thừa.",
  "Held out:": "Giữ riêng:",
  "windows from {p} patients ({r} records). The training script refuses to run if the two patient sets intersect.":
    "cửa sổ từ {p} bệnh nhân ({r} bản ghi). Script huấn luyện từ chối chạy nếu hai tập bệnh nhân giao nhau.",
  "Augmentation is baseline wander (0.05–0.5 Hz, ±0.6), gain drift (0.92–1.08), time shift (±20 ms) and small Gaussian noise. No time stretching: that would invent heart rates the patient never had.":
    "Tăng cường dữ liệu gồm trôi đường nền (0,05–0,5 Hz, ±0,6), trôi biên độ (0,92–1,08), dịch thời gian (±20 ms) và nhiễu Gauss nhỏ. Không kéo giãn thời gian: làm vậy sẽ bịa ra nhịp tim mà bệnh nhân chưa từng có.",

  // ---- evaluation ----------------------------------------------------------
  "{n} beats from six patients whose recordings never enter training. Accuracy is inflated by the N majority — a model that answered N for every beat would score {acc} and have a macro-F1 near {f1} — so macro-F1 is the number to read.":
    "{n} nhịp từ sáu bệnh nhân có bản ghi không bao giờ vào tập huấn luyện. Độ chính xác bị thổi phồng bởi đa số N — một mô hình luôn trả lời N cho mọi nhịp sẽ đạt {acc} và có macro-F1 khoảng {f1} — nên macro-F1 mới là con số để đọc.",
  "Confusion matrix": "Ma trận nhầm lẫn",
  "The dominant error is N → Q: {n} normal beats called unclassifiable, {pct} of all N beats and more than every other N error combined.":
    "Lỗi chiếm ưu thế là N → Q: {n} nhịp bình thường bị gọi là không phân loại được, chiếm {pct} tổng số nhịp N và nhiều hơn mọi lỗi N khác cộng lại.",
  "Per class": "Theo từng nhóm",
  "F1 by class": "F1 theo nhóm",
  "{name}: F1 {v}": "{name}: F1 {v}",

  // ---- per patient ---------------------------------------------------------
  "The pooled number hides how much the model varies between people, so the spread is reported rather than an average. Four of the six held-out patients have no S beats and one has no V beats; the last column therefore averages F1 over the classes that patient actually has, which is the honest comparison across rows.":
    "Con số gộp che mất mức mô hình thay đổi giữa các bệnh nhân, nên độ phân tán được báo cáo thay vì một giá trị trung bình. Bốn trong sáu bệnh nhân giữ riêng không có nhịp S và một người không có nhịp V; vì thế cột cuối lấy trung bình F1 trên đúng những nhóm mà bệnh nhân đó có, đó mới là so sánh trung thực giữa các dòng.",
  "Present-class macro-F1": "Macro-F1 các nhóm có mặt",
  "The mean of the last column is {m} — the same as the pooled macro-F1, which is the reassurance this table was meant to test. The spread is still wide: the worst patient scores {lo} and the best {hi}, and the bad ones are the recordings dominated by unusable stretches. The model is not uniformly mediocre; it fails where the signal does.":
    "Trung bình của cột cuối là {m} — bằng đúng macro-F1 gộp, đó chính là điều bảng này được lập ra để kiểm. Độ phân tán vẫn rộng: bệnh nhân kém nhất đạt {lo} và tốt nhất {hi}, và những ca kém là những bản ghi bị các đoạn không dùng được chi phối. Mô hình không tầm thường một cách đồng đều; nó hỏng ở đúng chỗ tín hiệu hỏng.",

  // ---- parity --------------------------------------------------------------
  "The app has no inference engine. The weights travel as JSON and":
    "Ứng dụng không có engine suy luận. Trọng số đi kèm dưới dạng JSON và",
  "runs a hand-written forward pass. That is only defensible if the two implementations agree, so the exporter wrote eight validation windows and PyTorch's exact logits into the model file. The table below is recomputed":
    "chạy một lượt lan truyền xuôi tự viết. Điều đó chỉ đứng vững nếu hai bản cài đặt khớp nhau, nên bước xuất đã ghi tám cửa sổ kiểm định cùng logits chính xác của PyTorch vào tệp mô hình. Bảng dưới được tính lại",
  "in your browser": "ngay trong trình duyệt của bạn",
  "as this page loads, by the same code the monitor uses.":
    "khi trang này tải, bằng đúng đoạn mã màn hình chính dùng.",
  "Argmax agreement": "Mức khớp argmax",
  "windows where both pick the same class": "cửa sổ mà cả hai chọn cùng một nhóm",
  "Worst |Δlogit|": "|Δlogit| lớn nhất",
  "tolerance 2e-4": "dung sai 2e-4",
  "Shared code": "Mã dùng chung",
  "PyTorch and TypeScript implementations": "Bản cài đặt PyTorch và TypeScript",
  "Agreement at this scale pins the weight layout, the BatchNorm folding, the padding, the pooling truncation and the per-window normalisation. A shape check would catch none of them — and getting any one wrong does not throw, it silently degrades every classification.":
    "Sự khớp ở mức này ghim chặt cách bố trí trọng số, phép gộp BatchNorm, phần đệm, phép cắt khi gộp và chuẩn hoá từng cửa sổ. Kiểm tra kích thước không bắt được điều nào trong số đó — và sai bất kỳ điều nào cũng không ném lỗi, nó âm thầm làm hỏng mọi lần phân loại.",

  // ---- cost ----------------------------------------------------------------
  "Raw scalar throughput in this environment measures about 721 MMAC/s, so a ~225k-MAC window is ~0.3 ms of arithmetic and about 1 ms per beat end to end. The spread is machine load, not the model: repeat runs on the same segment measured 0.95–1.3 ms per beat as this machine's load moved between 24% and 57%. An earlier four-block design measured 1.1M MAC and took 34 s per segment; it was replaced, not optimised. Computing the three ratios for the whole peak train costs 35 ms, so the extra inputs are not what the runtime is spending.":
    "Thông lượng vô hướng thô trên máy này đo được khoảng 721 MMAC/s, nên một cửa sổ ~225k MAC là ~0,3 ms phép tính và khoảng 1 ms mỗi nhịp tính cả đầu vào đầu ra. Độ phân tán là do tải máy, không phải mô hình: chạy lặp trên cùng đoạn cho 0,95–1,3 ms mỗi nhịp khi tải máy dao động giữa 24% và 57%. Một thiết kế bốn khối trước đó đo được 1,1M MAC và mất 34 s mỗi đoạn; nó bị thay chứ không được tối ưu. Tính ba tỉ số cho toàn bộ chuỗi đỉnh tốn 35 ms, nên các đầu vào phụ không phải chỗ thời gian chạy được tiêu.",
  "Per beat": "Mỗi nhịp",
  "measured on p00000_s00": "đo trên p00000_s00",
  "Per segment": "Mỗi đoạn",
  "6,886 beats, in a worker": "6.886 nhịp, trong một worker",
  "Model file": "Tệp mô hình",
  "JSON, incl. parity windows": "JSON, kể cả các cửa sổ đối chiếu",
  "Detector, for scale": "Bộ dò, để so sánh",
  "median per segment": "trung vị mỗi đoạn",
  "Classification runs in a worker over the same peak set the rest of the app uses — detector peaks when the detector is on, annotations otherwise — so playback continues while a segment is classified.":
    "Việc phân loại chạy trong một worker trên đúng tập đỉnh mà phần còn lại của ứng dụng đang dùng — đỉnh của bộ dò khi bộ dò bật, ngược lại là nhãn — nên quá trình phát vẫn tiếp tục trong lúc một đoạn đang được phân loại.",

  // ---- boundary ------------------------------------------------------------
  "The largest remaining error is {n} normal beats called Q. If that is a badly placed decision boundary rather than a missing input, a post-hoc bias on the two logits should move it. It does — and the gain does not survive the check that it is not this checkpoint's luck.":
    "Lỗi lớn nhất còn lại là {n} nhịp bình thường bị gọi là Q. Nếu đó là ranh giới quyết định đặt lệch chứ không phải thiếu đầu vào, thì một bias thêm vào sau trên hai logit phải dịch được nó. Nó dịch được — và mức tăng đó không sống sót qua phép kiểm xem có phải chỉ là may mắn của checkpoint này.",
  "The largest remaining error is normal beats called Q. Run":
    "Lỗi lớn nhất còn lại là các nhịp bình thường bị gọi là Q. Chạy",
  "to fill this section.": "để điền phần này.",
  "The rule adds a constant to Q's logit and the opposite to N's, leaving S and V alone. No retrain: the weights are unchanged, so the only thing that moves is where the line between “noisy normal” and “unusable” is drawn.":
    "Quy tắc cộng một hằng số vào logit của Q và trừ đúng chừng đó ở N, để yên S và V. Không huấn luyện lại: trọng số giữ nguyên, nên thứ duy nhất dịch chuyển là chỗ đường ranh giữa “bình thường nhiễu” và “không dùng được” được vẽ.",
  bias: "bias",
  accuracy: "độ chính xác",
  "macro-F1": "macro-F1",
  "0.00 (argmax)": "0,00 (argmax)",
  "N→Q at the best bias": "N→Q ở bias tốt nhất",
  "of {n}": "trên {n}",
  "−{pct}% of the cell": "−{pct}% của ô",
  "on the held-out patients, tuned on them": "trên các bệnh nhân giữ riêng, chỉnh ngay trên họ",
  "Out of fold": "Ngoài fold",
  "tuned on five patients, scored on the sixth":
    "chỉnh trên năm bệnh nhân, chấm trên người thứ sáu",
  "Checkpoints it helps": "Số checkpoint nó giúp",
  "same constant, {which} of them": "cùng hằng số, {which} trong số đó",
  all: "tất cả",
  "not all": "không phải tất cả",
  "Out of fold, the rule survives.": "Ngoài fold, quy tắc vẫn đứng.",
  "Tuning the constant on five patients and scoring the sixth gives macro-F1 {f1}, a gain of {gain} over the plain argmax, with the per-fold constant landing between −0.75 and −1.00 every time. That rules out the rule having been fitted to the six.":
    "Chỉnh hằng số trên năm bệnh nhân rồi chấm người thứ sáu cho macro-F1 {f1}, tăng {gain} so với argmax thuần, và hằng số của mỗi fold luôn rơi vào khoảng −0,75 đến −1,00. Điều đó loại trừ khả năng quy tắc được khớp riêng cho sáu người này.",
  checkpoint: "checkpoint",
  "extra input": "đầu vào phụ",
  argmax: "argmax",
  biased: "có bias",
  delta: "chênh lệch",
  "And then it does not survive.": "Và rồi nó không đứng vững.",
  "The same constant, on the same beats, helps {a} of {b} checkpoints. Two of them move backwards by roughly 0.01 while every one of them loses 70–77% of its N→Q cell and gains 0.05–0.08 accuracy. The cell is a boundary problem; whether hoisting the boundary improves macro-F1 is a property of the particular run, and 0.05 is this recipe's run-to-run spread. So the rule is documented, not shipped, and the model still decides with the plain argmax.":
    "Cùng một hằng số, trên cùng số nhịp đó, giúp {a} trong {b} checkpoint. Hai trong số đó đi lùi khoảng 0,01 trong khi tất cả đều mất 70–77% ô N→Q và tăng 0,05–0,08 độ chính xác. Ô đó là một bài toán ranh giới; việc nâng ranh giới lên có cải thiện macro-F1 hay không là tính chất của từng lần chạy cụ thể, và 0,05 chính là độ phân tán giữa các lần chạy của công thức này. Vì thế quy tắc được ghi lại chứ không được phát hành, và mô hình vẫn quyết định bằng argmax thuần.",
  "Per patient the constant a model would choose for itself runs from {lo} to {hi}, worth {best} on the recording that wants it most and nothing on the one that wants none. The ones that want a large shift are the recordings dominated by unusable signal, so the right correction is a per-recording prior — which a one-second window cannot know. A pooled prior correction from the training frequencies lands at Q −0.09 and takes macro-F1 down to 0.552 by dragging S and V with it. Numbers in":
    "Theo từng bệnh nhân, hằng số mà mô hình sẽ tự chọn chạy từ {lo} đến {hi}, đáng giá {best} trên bản ghi cần nó nhất và không đáng gì trên bản ghi không cần. Những bản ghi cần dịch nhiều là những bản ghi bị tín hiệu không dùng được chi phối, nên cách chỉnh đúng là một prior riêng cho từng bản ghi — điều mà cửa sổ một giây không thể biết. Một prior gộp từ tần số huấn luyện rơi vào Q −0,09 và kéo macro-F1 xuống 0,552 vì kéo theo cả S và V. Số liệu trong",
  and: "và",

  // ---- limits --------------------------------------------------------------
  "These are measured failure modes, not caveats added for tone.":
    "Đây là những kiểu hỏng đã được đo, không phải lời bảo lưu thêm vào cho có giọng điệu.",
  "N → Q, {n} errors — still the largest.": "N → Q, {n} lỗi — vẫn là lớn nhất.",
  "Q marks unusable stretches, and unusable stretches are noisier, so their amplitude is larger and per-beat normalisation divides that cue away.":
    "Q đánh dấu những đoạn không dùng được, và những đoạn đó nhiễu hơn, nên biên độ lớn hơn và phép chuẩn hoá theo từng nhịp chia mất tín hiệu đó.",
  "was added to restore it and the ablation showed the network ignores it; the timing ratios were aimed at S and V and barely touched this cell either. So the boundary itself was attacked — a logit bias on N and Q — and the answer is that it is a boundary problem: the cell shrinks sharply and accuracy rises, but":
    "được thêm vào để khôi phục tín hiệu đó và phép loại bỏ cho thấy mạng bỏ qua nó; các tỉ số thời gian nhắm vào S và V nên hầu như không động tới ô này. Vì thế bản thân ranh giới bị đánh trực diện — một bias logit cho N và Q — và câu trả lời là đây đúng là bài toán ranh giới: ô nhỏ đi rõ rệt và độ chính xác tăng, nhưng",
  "the macro-F1 gain holds on {a} of {b} checkpoints, so it is not shipped.":
    "mức tăng macro-F1 chỉ đứng trên {a} trong {b} checkpoint, nên nó không được phát hành.",
  "the gain does not hold on every checkpoint, so it is not shipped.":
    "mức tăng không đứng trên mọi checkpoint, nên nó không được phát hành.",
  "Q is 24% of the corpus and carries a large weight, so an ambiguous noisy beat is cheaper to call Q than N. Q precision of {pct} says most Q calls are wrong.":
    "Q chiếm 24% kho dữ liệu và mang trọng số lớn, nên một nhịp nhiễu nước đôi thì gọi Q rẻ hơn gọi N. Độ chính xác dương tính của Q là {pct}, nghĩa là phần lớn các lần gọi Q đều sai.",
  "S improved but is not solved.": "S đã tốt lên nhưng chưa được giải quyết.",
  "The three timing ratios gave it the context a window cannot hold — zeroing them costs {drop} F1 on S, the largest effect in the table above — and S F1 is now {f1}, the best it has been. Precision is the soft spot at {ppv}: many normal beats are a little early, and prematurity alone cannot tell sinus arrhythmia from an ectopic beat. Morphology and timing together are what a cardiologist uses, and the network has both now.":
    "Ba tỉ số thời gian cho nó bối cảnh mà một cửa sổ không chứa được — đặt chúng về 0 làm mất {drop} F1 trên S, hiệu ứng lớn nhất trong bảng trên — và F1 của S nay là {f1}, mức tốt nhất từ trước tới giờ. Điểm yếu là độ chính xác dương tính ở {ppv}: nhiều nhịp bình thường hơi sớm, và chỉ riêng độ sớm thì không phân biệt được loạn nhịp xoang với một nhịp ngoại tâm thu. Hình thái và thời điểm đi cùng nhau mới là thứ bác sĩ tim mạch dùng, và mạng nay đã có cả hai.",
  "V is now the weakest class, for the same reason.": "V nay là nhóm yếu nhất, vì cùng lý do đó.",
  "{se} recall at {ppv} precision, and 3,218 ventricular beats called S. The ratios let it see that a beat is premature, and it now picks the wrong ectopic class instead of missing the timing entirely — a different error at a similar score. V is rare enough that a handful of mistakes moves the number.":
    "Độ nhạy {se} ở độ chính xác dương tính {ppv}, và 3.218 nhịp thất bị gọi là S. Các tỉ số giúp nó thấy một nhịp đến sớm, và nay nó chọn nhầm nhóm ngoại tâm thu thay vì bỏ qua hoàn toàn thời điểm — một lỗi khác ở mức điểm tương tự. V hiếm đến mức vài lỗi là đủ làm con số dịch.",
  "The per-patient spread is wide.": "Độ phân tán giữa các bệnh nhân rộng.",
  "Present-class macro-F1 runs from {lo} to {hi} across the six held-out patients, and the low end is always a recording dominated by unusable stretches. Six patients is enough to see the spread, not enough to average it away.":
    "Macro-F1 các nhóm có mặt chạy từ {lo} đến {hi} trên sáu bệnh nhân giữ riêng, và đầu thấp luôn là một bản ghi bị các đoạn không dùng được chi phối. Sáu bệnh nhân đủ để thấy độ phân tán, chưa đủ để lấy trung bình mà xoá nó đi.",
  "No F class.": "Không có nhóm F.",
  "icentia11k does not carry AAMI's fusion class, so the model has four outputs, not five.":
    "icentia11k không có nhóm hợp nhất (fusion) của AAMI, nên mô hình có bốn đầu ra chứ không phải năm.",
  "This is a rebuild's demonstration model, trained on 24 patients to show that the pipeline is honest end to end. It is not a medical device, and {pct} held-out accuracy is not a number to act on.":
    "Đây là mô hình minh hoạ của một bản dựng lại, huấn luyện trên 24 bệnh nhân để cho thấy pipeline trung thực từ đầu đến cuối. Nó không phải thiết bị y tế, và độ chính xác {pct} trên tập giữ riêng không phải con số để hành động theo.",
};
