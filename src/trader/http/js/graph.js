async function showGraph() {
    var options = {
        chart: {
            height: 380,
            width: "100%",
            type: "area",
            animations: {
                initialAnimation: {
                    enabled: false
                }
            }
        },
        series: [],
        noData: {
            text: "Loading...",
            align: 'center',
            verticalAlign: 'middle',
            offsetX: 0,
            offsetY: 0,
            style: {
                color: '#000000',
                fontSize: '14px',
                fontFamily: 'Helvetica'
            }
        }
    };

    await sleep(5000);

    var chart = new ApexCharts(document.querySelector("#chart"), options);
    document.querySelector("#chart").classList.remove("loading");
    chart.render();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}