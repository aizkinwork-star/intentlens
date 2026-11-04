# Third-Party Notices

## ElectroCom61 Dataset

- **Dataset name:** ElectroCom61 (ElectroCom-60 on Roboflow)
- **Authors:** Provided by a Roboflow user (datasetsynthesis workspace)
- **Source URL:** https://universe.roboflow.com/datasetsynthesis/electrocom-60/dataset/5
- **DOI:** 10.17632/6scy6h8sjz.2
- **License:** CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)
- **Import date:** 2026-10-31
- **Dataset version:** 5 (Roboflow export)

### Attribution
This project uses the ElectroCom61 dataset for training a non-neural k-NN component classifier.
The dataset is licensed under CC BY 4.0. Attribution is provided as required.

### Citation
If you use this dataset, please cite:
> ElectroCom61: A Multiclass Dataset for Detection of Electronic Components.
> DOI: 10.17632/6scy6h8sjz.2
> License: CC BY 4.0

### Dataset location
- Raw archive: `datasets/imports/ElectroCom61.zip`
- Extracted: `datasets/raw/electrocom61/`
- Processed crops: `datasets/processed/crops/`
- Contact sheets: `datasets/processed/contact_sheets/`

### Usage in IntentLens
- 12,667 component crops extracted from 2,071 images.
- 61 classes preserved (original class IDs and names).
- Crops organized by class ID and name in `datasets/processed/crops/`.
- Feature extraction uses `FeatureExtractor.js` (HSV histogram, Hu moments, HOG, shape descriptors).
- k-NN classification via `KNNClassifier.js`.
- Raw dataset excluded from Electron installer.