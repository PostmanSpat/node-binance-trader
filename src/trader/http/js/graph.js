async function showGraph() {
    // Fetch the summarised transaction data from the server
    return fetch('/trans' + window.location.search)
    .then(response => {
        return response.text()
    })
    .then((data) => {
        render(data ? JSON.parse(data) : {})
    })
    .catch((error) => {
        var div = document.querySelector("#error")
        div.innerText = error
        div.classList.remove("hidden")

        document.querySelector("#pnl").classList.remove("loading")
        document.querySelector("#trades").classList.remove("loading")
        document.querySelector("#volume").classList.remove("loading")
    })
}

function render(data) {
    // Used to hold each of the series for the three graphs
    var series = {
        pnl: {},
        volume: {},
        trades: {}
    }
    // Used to track all possible timesteps from every series so that graphs can be synchronised
    var timesteps = new Set()

    // Step through summarised transaction data
    for (var strategy in data) {
        for (var position in data[strategy]) {
            for (var timestep in data[strategy][position]) {
                var summ = data[strategy][position][timestep]

                for (var param in summ) {
                    var chart = ""
                    var value = summ[param]

                    // Map each parameter to a chart
                    switch (param) {
                        case "closed":
                            // Closed trades displayed as downwards columns
                            value = 0 - value
                        case "opened":
                            chart = "trades"
                            break
                        case "sell":
                            // Sell quantities displayed as downwards columns
                            value = 0 - value
                        case "buy":
                            chart = "volume"
                            break
                        case "profitLoss":
                            chart = "pnl"
                            break
                    }

                    // Convert parameter to series
                    var name = strategy
                    if (Object.keys(data[strategy]).length > 1) name += " : " + position // Don't add position if there is only one for the strategy
                    if (param != "profitLoss") name += " : " + param // ProfitLoss is the only param that goes on the PnL chart
                    if (!(name in series[chart])) {
                        series[chart][name] = {
                            name: name,
                            type: chart == "pnl" ? "area" : "column",
                            data: {}
                        }
                    }
                    // Index by timestamp first so that we can fill in missing data later
                    series[chart][name].data[timestep] = value
                    timesteps.add(timestep)

                    // Sum values from all series in the chart
                    var totalName = ""
                    switch (chart) {
                        case "pnl":
                            totalName = "*** Total ***"
                            break
                        case "trades":
                            totalName = "*** Active Trades ***"
                            break
                        /*case "volume":
                            totalName = "*** Invested ***"
                            break*/
                    }
                    if (totalName) {
                        if (!(totalName in series[chart])) {
                            series[chart][totalName] = {
                                name: totalName,
                                type: "area",
                                data: {}
                            }
                        }
                        if (!(timestep in series[chart][totalName].data)) {
                            series[chart][totalName].data[timestep] = 0
                        }
                        series[chart][totalName].data[timestep] += value
                    }
                }
            }
        }
    }
    
    // Flatten data into valid series
    for (var chart in series) {
        var options = {
            chart: {
                id: chart,
                group: "nbt", // Group together so that they zoom and hover together
                height: "49%", // First two graphs will take up the whole screen because they are the most interesting
                width: "100%",
                type: "area",
                stacked: chart != "pnl", // Stacked pnl is too hard to understand
                animations: {
                    initialAnimation: {
                        enabled: true
                    }
                },
                toolbar: {
                    export: {
                        csv: {
                            dateFormatter: function(timestamp) {
                                return new Date(timestamp).toISOString()
                            }
                        }
                    }
                }
            },
            dataLabels: {
                enabled: false // Don't need individual numbers displayed on each step of each series
            },
            series: [],
            stroke: {
                width: [],
                curve: []
            },
            fill: {
                type: []
            },
            // Because we can have a lot of series, we're going to make sure there are plenty of colours
            // Have an odd number so that if it does get reused it will be the opposite range
            colors: ['#008FFB', '#00E396', '#775DD0', '#FEB019', '#FF4560', '#5A2A27',
                    '#33B2DF', '#4CAF50', '#3F51B5', '#F9CE1D', '#F9A3A4', '#8D5B4C',
                    '#81D4FA', '#90EE7E', '#A300D6', '#C5D86D', '#D4526E'],
            xaxis: {
                type: 'datetime',
                labels: {
                    datetimeUTC: false
                }
            },
            yaxis: {
                forceNiceScale: true, // This actually doesn't work for ranges less than 2 (e.g. BTC quantities)
                labels: {
                    minWidth: 80,
                    formatter: function (val) {
                        if (val == null) return ""
                        return Number(val.toFixed(8)).toString() // Need to do a custom format of numbers to limit precision
                    }
                }
            },
            tooltip: {
                x: {
                    show: true,
                    format: 'dd MMM hh tt', // Need to force the tooltip to show the time
                }
            },
            annotations: {
                yaxis: [{
                    y: 0, // Workaround, have to add in a line for zero because ranges less than 2 don't always have it
                    /*label: {
                        text: "0",
                        position: "left"
                    }*/
                }]
            },
            noData: {
                text: "No Data Available",
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
        }

        // If there is only one real series on the PnL then it will be exactly the same as the total, so remove the total
        if (chart == "pnl" && Object.keys(series[chart]).length == 2) {
            delete series[chart]["*** Total ***"]
        } else if (chart != "volume") {
            // Otherwise the first series should be a total, so we'll give it a special colour
            options.colors.unshift('#BCBCBC')
        }

        // Flatten all series into chart options
        // Ensure all series are sorted alphabetically by name before processing
        options.series = Object.values(series[chart]).sort((a, b) => a.name.localeCompare(b.name))
        for (var s of options.series) {
            // Fill in missing timesteps to keep the chart happy
            for (var timestep of timesteps) {
                if (!(timestep in s.data)) {
                    s.data[timestep] = null
                }
            }

            var flat = []
            // Keep a running balance for cumulative values
            var balance = {
                pnl: null,
                volume: null,
                trades: null
            }
            // Track the minimum value so series can be offset back to zero
            var min = {
                pnl: 0,
                volume: 0,
                trades: 0
            }
            // Convert data into valid series data, sorted by timestamp
            for (var timestep of Object.keys(s.data).sort()) {
                if (s.type == "area") {
                    // Allow null data at the start
                    if (s.data[timestep] != null) {
                        if (balance[chart] == null) balance[chart] = 0

                        // Convert to a running balance for area charts
                        balance[chart] += s.data[timestep]

                        // Track the minimum value
                        if (balance[chart] < min[chart]) min[chart] = balance[chart]
                    }
                    flat.push([parseInt(timestep), balance[chart]])
                } else {
                    // Display absolute values for columns, but not zeros
                    flat.push([parseInt(timestep), s.data[timestep] ? s.data[timestep] : null])
                }
            }
            if (chart != "pnl" && s.type == "area" && min[chart] < 0) {
                // Offset the total trades my the minimum value
                // This is not technically accurate, but it works of the assumption that at some point in time you will have zero open trades
                for (var i=0; i<flat.length; ++i) {
                    flat[i][1] -= min[chart]
                }
            }

            // Thesr options need to be added in the same order as the series
            if (s.type == "column") {
                // Columns have no border and are solid colour
                options.stroke.width.push(0)
                options.fill.type.push('solid')
            } else {
                // Areas have a thick line and shaded colour
                options.stroke.width.push(4)
                options.fill.type.push('gradient')
            }
            if (chart == "pnl") {
                // PnL chart uses straight line area graphs
                options.stroke.curve.push('straight')
            } else {
                // Trade total uses a stepline area graph
                options.stroke.curve.push('stepline')
            }

            // Replace the series data with the valid format
            s.data = flat
        }

        // Add chart titles
        var title = ""
        switch (chart) {
            case "pnl":
                title = "Accumulated Profit and Loss"
                break
            case "trades":
                title = "Trade Counts"
                break
            case "volume":
                title = "Trade Volume"
                break
        }
        options.title = {
            text: title
        }

        // Create the chart
        var div = document.querySelector("#" + chart)
        var chart = new ApexCharts(div, options)
        // Remove the loading icon
        div.classList.remove("loading")
        // Render for display
        chart.render()
    }
}