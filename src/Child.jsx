import React from "react";

const Child = ({ increment }) => {
    console.log("child called");
    return (
        <div>
            Child
            <button onClick={increment}>Increment</button>
        </div>
    )
}

export default React.memo(Child);
// export default Child;