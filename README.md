[![Lexcube Logo](/readme-media/lexcube-logo.png)](https://github.com/msoechting/lexcube)

**3D Data Cube Visualization in Jupyter Notebooks**

![Lexcube Demo GIF](https://raw.githubusercontent.com/msoechting/lexcube/main/readme-media/lexcube-demo.gif)

--- 

**GitHub**: [https://github.com/msoechting/lexcube](https://github.com/msoechting/lexcube)

**Paper**: [https://doi.org/10.1109/MCG.2023.3321989](https://doi.org/10.1109/MCG.2023.3321989)

**PyPI**: [https://pypi.org/project/lexcube/](https://pypi.org/project/lexcube/)

---

Lexcube is a library for interactively visualizing three-dimensional floating-point data as 3D cubes in Jupyter notebooks. 

Supported data formats:
- numpy.ndarray (with exactly 3 dimensions)
- xarray.DataArray (with exactly 3 dimensions, rectangularly gridded)

Possible data sources:
- Any gridded Zarr or NetCDF data set (local or remote, e.g., accessed with S3)
- Copernicus Data Storage, e.g., [ERA5 data](https://cds.climate.copernicus.eu/cdsapp#!/dataset/reanalysis-era5-complete?tab=overview)
- Google Earth Engine ([using xee, see example notebook](https://github.com/msoechting/lexcube/blob/main/examples/4_google_earth_engine.ipynb))

Example notebooks can be found in the [examples](https://github.com/msoechting/lexcube/tree/main/examples) folder. For a live demo, see also [lexcube.org](https://www.lexcube.org).

## Attribution

When using Lexcube in your research, please cite:
```bibtex
@article{soechting2023lexcube,
  author={Söchting, Maximilian and Mahecha, Miguel D. and Montero, David and Scheuermann, Gerik},
  journal={IEEE Computer Graphics and Applications}, 
  title={Lexcube: Interactive Visualization of Large Earth System Data Cubes}, 
  year={2023},
  doi={10.1109/MCG.2023.3321989}
}
```
Lexcube is a project by Maximilian Söchting at the [RSC4Earth](https://www.rsc4earth.de/) at Leipzig University, advised by Prof. Dr. Miguel D. Mahecha and Prof. Dr. Gerik Scheuermann. Thanks to the funding provided by ESA through DeepESDL and DFG through the NFDI4Earth pilot projects!

## How to Use Lexcube
If you are new to Lexcube, try the [general introduction notebook](https://github.com/msoechting/lexcube/blob/main/examples/1_introduction.ipynb) which demonstrates how to visualize a remote Xarray data set.

There are also specific example notebooks for the following use cases:
- [Visualizing Google Earth Engine data - using xee](https://github.com/msoechting/lexcube/blob/main/examples/4_google_earth_engine.ipynb)
- [Generating and visualizing a spectral index data cube from scratch - using cubo and spyndex](https://github.com/msoechting/lexcube/blob/main/examples/3_spectral_indices_with_cubo_and_spyndex.ipynb)
- [Visualizing Numpy data](examples/2_numpy.ipynb)

### Minimal Examples for Getting Started 
#### Visualizing Xarray Data
```python
import xarray as xr
import lexcube 
ds = xr.open_dataset("http://data.rsc4earth.de/EarthSystemDataCube/v3.0.2/esdc-8d-0.25deg-256x128x128-3.0.2.zarr/", chunks={}, engine="zarr")
da = ds["air_temperature_2m"][256:512,256:512,256:512]
w = lexcube.Cube3DWidget(da, cmap="thermal_r", vmin=-20, vmax=30)
w
```
#### Visualizing Numpy Data
```python
import numpy as np
import lexcube 
data_source = np.sum(np.mgrid[0:256,0:256,0:256], axis=0)
w = lexcube.Cube3DWidget(data_source, cmap="prism", vmin=0, vmax=768)
w
```

#### Visualizing Google Earth Engine Data
See [the full example here](https://github.com/msoechting/lexcube/blob/main/examples/4_google_earth_engine.ipynb).
```python 
import lexcube
import xarray as xr
import ee
ee.Authenticate()
ee.Initialize(opt_url='https://earthengine-highvolume.googleapis.com')
ds = xr.open_dataset('ee://ECMWF/ERA5_LAND/HOURLY', engine='ee', crs='EPSG:4326', scale=0.25, chunks={})
da = ds["temperature_2m"][630000:630003,2:1438,2:718]
w = lexcube.Cube3DWidget(da)
w
```

#### Note on Google Collab
If you are using Google collab, you need to execute the following before running Lexcube:

```python
from google.colab import output
output.enable_custom_widget_manager()
```

## Installation

You can install using `pip`:

```bash
pip install lexcube
```

After installing or upgrading Lexcube, you should **refresh the Juypter web page** (if currently open) and **restart the kernel** (if currently running).

If you are using Jupyter Notebook 5.2 or earlier, you may also need to enable
the nbextension:
```bash
jupyter nbextension enable --py [--sys-prefix|--user|--system] lexcube
```

## Cube Visualization
On the cube, the dimensions are visualized as follow: X from left-to-right (0 to max), Y from top-to-bottom (0 to max), Z from back-to-front (0 to max); with Z being the first dimension (`axis[0]`), Y the second dimension (`axis[1]`) and X the third dimension (`axis[2]`) on the input data. If you prefer to flip any dimension or re-order dimensions, you can modify your data set accordingly before calling the Lexcube widget, e.g. re-ordering dimensions with xarray: `ds.transpose(ds.dims[0], ds.dims[2], ds.dims[1])` and flipping dimensions with numpy: `np.flip(ds, axis=1)`.

## Interacting with the Cube
- Zooming in/out on any side of the cube: 
    - Mousewheel
    - Scroll gesture on touchpad (two fingers up or down)
    - On touch devices: Two-touch pinch gesture
- Panning the currently visible selection: 
    - Click and drag the mouse cursor
    - On touch devices: touch and drag
- Moving over the cube with your cursor will show a tooltip in the bottom left about the pixel under the cursor.
- For more precise input, you can use the sliders provided by `w.show_sliders()`.


## Range Boundaries
You can read and write the boundaries of the current selection via the `xlim`, `ylim` and `zlim` tuples.

```python
w = lexcube.Cube3DWidget(da, cmap="thermal", vmin=-20, vmax=30)
w
# Next cell:
w.xlim = (20, 400)
```

For fine-grained interactive controls, you can display a set of sliders in another cell, like this:

```python
w = lexcube.Cube3DWidget(da, cmap="thermal", vmin=-20, vmax=30)
w
# Next cell:
w.show_sliders()
```
For very large data sets, you may want to use `w.show_sliders(continuous_update=False)` to prevent any data being loaded before making a final slider selection. 

If you want to wrap around a dimension, i.e., seamleasly scroll over back to the 0-index beyond the maximum index, you can enable that feature like this: 
```python
w.xwrap = True
```
For data sets that have longitude values in their metadata very close to a global round-trip, this is automatically active for the X dimension.

*Limitations: Currently only supported for the X dimension. If xwrap is active, the xlim tuple may contain values up to double the valid range to always have a range where x_min < x_max. To get values in the original/expected range, you can simply calculate x % x_max.*

## Colormaps
All colormaps of matplotlib and cmocean are supported.
The range of the colormap, if not set using `vmin`/`vmax`, is automatically adjusted to the approximate observed minimum and maximum values<sup>*note*</sup> within the current session. Appending "_r" to any colormap name will reverse it.


```python
# 1) Set cmap in constructor
w = lexcube.Cube3DWidget(da, cmap="thermal", vmin=-20, vmax=30)
w

# 2) Set cmap later
w.cmap = "thermal"
w.vmin = -20
w.vmax = 30

# 3) Set custom colormap using lists (evenly spaced RGB values)
w.cmap = cmocean.cm.thermal(np.linspace(0.0, 1.0, 100)).tolist()
w.cmap = [[0.0, 0.0, 0.0], [1.0, 0.5, 0.5], [0.5, 1.0, 1.0]]
```

<sup><sup>*note*</sup> Lexcube actually calculates the mean of all values that have been visible so far in this session and applies ±2.5σ (standard deviation) in both directions to obtain the colormap ranges, covering approximately 98.7% of data points. This basic method allows to filter most outliers that would otherwise make the colormap range unnecessarily large and, therefore, the visualization uninterpretable.</sup>

### Supported colormaps
```python
Cmocean:"thermal","haline","solar","ice","gray","oxy","deep","dense","algae","matter","turbid","speed","amp","tempo","rain","phase","topo","balance","delta","curl","diff","tarn"
PerceptuallyUniformSequential:"viridis","plasma","inferno","magma","cividis"
Sequential:"Greys","Purples","Blues","Greens","Oranges","Reds","YlOrBr","YlOrRd","OrRd","PuRd","RdPu","BuPu","GnBu","PuBu","YlGnBu","PuBuGn","BuGn","YlGn"
Sequential(2):"binary","gist_yarg","gist_gray","gray","bone","pink","spring","summer","autumn","winter","cool","Wistia","hot","afmhot","gist_heat","copper"
Diverging:"PiYG","PRGn","BrBG","PuOr","RdGy","RdBu","RdYlBu","RdYlGn","Spectral","coolwarm","bwr","seismic",
Cyclic:"twilight","twilight_shifted","hsv"
Qualitative:"Pastel1","Pastel2","Paired","Accent","Dark2","Set1","Set2","Set3","tab10","tab20","tab20b","tab20c"
Miscellaneous:"flag","prism","ocean","gist_earth","terrain","gist_stern","gnuplot","gnuplot2","CMRmap","cubehelix","brg","gist_rainbow","rainbow","jet","nipy_spectral","gist_ncar"
```
## Save images
You can save PNG images of the cube like this: 
```python
w.savefig(fname="cube.png", include_ui=True, dpi_scale=2.0)
```
- `fname`: name of the image file. Default: `lexcube-{current time and date}.png`.
- `include_ui`: whether to include UI elements such as the axis descriptions and the colormap legend in the image. Default: `true`.
- `dpi_scale`: the image resolution is multiplied by this value to obtain higher-resolution/quality images. For example, a value of 2.0 means that the image resolution is doubled for the PNG vs. what is visible in the notebook. Default: `2.0`.

If you want to edit multiple cubes into one picture, you may prefer an isometric rendering. You can enable it in the constructor: `lexcube.Cube3DWidget(data_source, isometric_mode=True)`. For comparison:

![Isometric vs. perspective camera comparison](https://raw.githubusercontent.com/msoechting/lexcube/main/readme-media/isometric.png)


## Supported metadata
When using Xarray for the input data, the following metadata is automatically integrated into the visualization:

- Dimension names
    - Read from the xarray.DataArray.dims attribute
- Parameter name
    - Read from the xarray.DataArray.attrs.long_name attribute
- Units
    - Read from the xarray.DataArray.attrs.units attribute
- Indices
    - Time indices are converted to UTC and displayed in local time in the widget
    - Latitude and longitude indices are displayed in their full forms in the widget
    - Other indices (strings, numbers) are displayed in their full form
    - If no indices are available, the numeric indices are displayed

## Troubleshooting
Below you can find a number of different common issues when working with Lexcube. If the suggested solutions do not work for you, feel free to [open an issue](https://github.com/msoechting/lexcube/issues/new/choose)!

### The cube does not respond / API methods are not doing anything / Cube does not load new data
Under certain circumstances, the widget may get disconnected from the kernel. You can recognize it with this symbol (crossed out chain 🔗):
![Crossed-out chain symbol under cell](https://raw.githubusercontent.com/msoechting/lexcube/main/readme-media/disconnected.png)

Possible Solutions:
1. Execute the cell again
2. Restart the kernel
3. Refresh the web page (also try a "hard refresh" using CTRL+F5 or Command+Option+R - this forces the browser to ignore its cache)


### After installation/update, no widget is shown, only text
Example:
![Broken widget in post-installation](https://raw.githubusercontent.com/msoechting/lexcube/main/readme-media/post-installation-broken-widget.png)

Possible solutions:
1. Restart the kernel
2. Refresh the web page (also try a "hard refresh" using CTRL+F5 or Command+Option+R - this forces the browser to ignore its cache)

### w.savefig breaks when batch-processing/trying to create many figures quickly
The current `savefig` implementation is limited by its asynchronous nature. This means that the `savefig` call returns before the image is rendered and downloaded. Therefore, a workaround, such as waiting one second between images, is necessary to correctly create images when batchprocessing.

### The layout of the widget looks very messed up
This can happen in old versions of browsers. Update your browser or use a modern, up-to-date browser such as Firefox or Chrome. Otherwise, feel free to create an issue with your exact specs.

### "Error creating WebGL context" or similar
WebGL 2 seems to be not available or disabled in your browser. Check this page to test if your browser is compatible: https://webglreport.com/?v=2. Possible solutions are:
1. Update your browser
2. Update your video card drivers

### Memory is filling up a lot when using a chunked dataset 
Lexcube employs an alternative, more aggressive chunk caching mechanism in contrast to xarray. It will cache any touched chunk in memory without releasing it until the widget is closed. Disabling it will most likely decrease memory usage but increase the average data access latency, i.e., make Lexcube slower. To disable it, use: `lexcube.Cube3DWidget(data_source, use_lexcube_chunk_caching=False)`.


## Known bugs
- Zoom interactions with the mousewheel may be difficult for data sets with very small ranges on some dimensions (e.g. 2-5).
- Zoom interactions may behave unexpectedly when zooming on multiple cube faces subsequently.

## Open-Source Attributions

Lexcube uses lots of amazing open-source software, including:
* Data access: [Xarray](https://docs.xarray.dev/en/stable/index.html) & [Numpy](https://numpy.org/)
* Lossy floating-point compression: [ZFP](https://zfp.io/)
* Client boilerplate: [TypeScript Three.js Boilerplate](https://github.com/Sean-Bradley/Three.js-TypeScript-Boilerplate) by Sean Bradley
* Jupyter widget boilerplate: [widget-ts-cookiecutter](https://github.com/jupyter-widgets/widget-ts-cookiecutter)
* Colormaps: [matplotlib](https://matplotlib.org) & [cmocean](https://matplotlib.org/cmocean/)
* 3D graphics engine: [Three.js](https://github.com/mrdoob/three.js/) (including the OrbitControls, which have been modified for this project)
* Client bundling: [Webpack](https://webpack.js.org/)
* UI sliders: [Nouislider](https://refreshless.com/nouislider/)
* Decompression using WebAssembly: [numcodecs.js](https://github.com/manzt/numcodecs.js)
* WebSocket communication: [Socket.io](https://socket.io/)

## Development Installation & Guide
See [CONTRIBUTE.md](CONTRIBUTE.md).


## License
The Lexcube application core, the Lexcube Jupyter extension, and other portions of the official Lexcube distribution not explicitly licensed otherwise, are licensed under the GNU GENERAL PUBLIC LICENSE v3 or later (GPLv3+) -- see the 'COPYING' file in this directory for details.